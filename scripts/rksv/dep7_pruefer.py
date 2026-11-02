#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unabhängiger RKSV-Zweitprüfer für DEP7-Exporte — reines Python, NUR Standardbibliothek.

Warum es das gibt: Die Kassa prüft sich selbst (Burn-in, Selbsttest) mit Code, der dieselbe Lesart der
Spezifikation hat wie der Produktivcode. Dieser Prüfer ist bewusst in einer anderen Sprache geschrieben,
benutzt weder Node noch OpenSSL (ECDSA P-256 und AES-256 sind hier selbst gerechnet — es wird ja nur
geprüft, geheime Schlüssel gibt es nicht) und liest die Spezifikation direkt aus RKSV Anlage 1.

Eingabe
  --dep7    DEP7-Export (JSON): {"Belege-Gruppe": [{"Signaturzertifikat": ..., "Belege-kompakt": [JWS, ...]}]}
  --crypto  cryptographicMaterialContainer.json im Format des BMF-Prüftools:
            {"base64AESKey": ..., "certificateOrPublicKeyMap": {"<id>": {"signatureDeviceType":
            "CERTIFICATE"|"PUBLIC_KEY", "signatureCertificateOrPublicKey": "<Base64 DER>"}}}

Geprüft wird je Beleg (Regelnamen = Schlüssel im Bericht)
  jws-format          drei base64url-Teile, Header genau {"alg":"ES256"}, Nutzlast beginnt mit _R1-
  code-format         13 Felder, Beträge mit Dezimalkomma, Datum JJJJ-MM-TTThh:mm:ss, Zähler als Base64
  kassen-id           in allen Belegen gleich (ein DEP = eine Kasse)
  belegnummer         lückenlos aufsteigend (Standard: beginnend mit 1)
  zeit-rueckwaerts    Datum/Uhrzeit nicht rückläufig (Achtung: Zeitumstellung im Herbst, siehe Hinweis)
  verkettung          Sig-Voriger-Beleg = Base64(SHA-256(JWS-Compact des Vorbelegs)[0..7]); Start: Kassen-ID
  signatur            ES256 (r‖s, 64 Byte) über "Header.Nutzlast" gegen Zertifikat/Schlüssel; Ausfallmarker
                      „Sicherheitseinrichtung ausgefallen" wird gezählt, nicht geprüft
  schluessel-fehlt    zur Seriennummer im Beleg gibt es weder Zertifikat in der Gruppe noch Eintrag im Container
  zertifikat-sn       Seriennummer im Beleg = Seriennummer des Zertifikats (nur wenn die Angabe hexadezimal ist)
  umsatzzaehler       AES-256-ICM entschlüsselt = laufende Summe aller Beträge (Cent; Trainingsbelege ausgenommen)

Aufruf
  python3 dep7_pruefer.py --dep7 dep-export.json --crypto cryptographicMaterialContainer.json [--bericht out.json]
                          [--ignoriere regel,regel] [--erster-beleg 1] [--maximal 500]
  python3 dep7_pruefer.py --selbsttest

Ausgang: 0 = keine Verstöße, 1 = Verstöße, 2 = Eingabe unbrauchbar / Selbsttest fehlgeschlagen.
"""

import argparse
import base64
import hashlib
import json
import re
import sys

# ---------------------------------------------------------------------------
# Hilfsfunktionen
# ---------------------------------------------------------------------------

AUSFALL_TEXT = "Sicherheitseinrichtung ausgefallen"


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def b64_decode(text):
    return base64.b64decode(text + "=" * (-len(text) % 4), validate=True)


def sha256(daten):
    if isinstance(daten, str):
        daten = daten.encode("utf-8")
    return hashlib.sha256(daten).digest()


# ---------------------------------------------------------------------------
# AES-256 (nur Blockverschlüsselung; ICM/CTR braucht für einen Zähler ≤ 16 Byte nur den ersten Schlüsselstrom-Block)
# ---------------------------------------------------------------------------


def _baue_sbox():
    # Konstruktion nach FIPS-197 (Inverses in GF(2^8) + affine Abbildung), keine abgetippte Tabelle.
    sbox = [0] * 256
    p = q = 1
    while True:
        p = (p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)) & 0xFF   # p *= 3
        q = (q ^ (q << 1)) & 0xFF                                         # q /= 3
        q = (q ^ (q << 2)) & 0xFF
        q = (q ^ (q << 4)) & 0xFF
        if q & 0x80:
            q ^= 0x09

        def rotl(x, n):
            return ((x << n) | (x >> (8 - n))) & 0xFF

        sbox[p] = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox


_SBOX = _baue_sbox()


def _xtime(a):
    return ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else a << 1


def _aes256_rundenschluessel(schluessel):
    if len(schluessel) != 32:
        raise ValueError("AES-256 braucht einen 32-Byte-Schlüssel, bekam %d Byte" % len(schluessel))
    nk, nr = 8, 14
    w = [list(schluessel[4 * i:4 * i + 4]) for i in range(nk)]
    rcon = 1
    for i in range(nk, 4 * (nr + 1)):
        t = list(w[i - 1])
        if i % nk == 0:
            t = [_SBOX[b] for b in t[1:] + t[:1]]
            t[0] ^= rcon
            rcon = _xtime(rcon)
        elif i % nk == 4:
            t = [_SBOX[b] for b in t]
        w.append([w[i - nk][j] ^ t[j] for j in range(4)])
    return [[b for wort in w[4 * r:4 * r + 4] for b in wort] for r in range(nr + 1)]


def aes256_block_verschluesseln(schluessel, block):
    rk = _aes256_rundenschluessel(schluessel)
    s = [b ^ k for b, k in zip(block, rk[0])]
    for runde in range(1, 15):
        s = [_SBOX[b] for b in s]
        # ShiftRows (Zustand spaltenweise: s[4*spalte + zeile])
        s = [s[4 * ((c + r) % 4) + r] for c in range(4) for r in range(4)]
        if runde < 14:
            neu = []
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                neu += [
                    _xtime(a0) ^ (_xtime(a1) ^ a1) ^ a2 ^ a3,
                    a0 ^ _xtime(a1) ^ (_xtime(a2) ^ a2) ^ a3,
                    a0 ^ a1 ^ _xtime(a2) ^ (_xtime(a3) ^ a3),
                    (_xtime(a0) ^ a0) ^ a1 ^ a2 ^ _xtime(a3),
                ]
            s = neu
        s = [b ^ k for b, k in zip(s, rk[runde])]
    return bytes(s)


def umsatzzaehler_entschluesseln(chiffre, aes_schluessel, kassen_id, belegnummer):
    """RKSV Anlage 1 Z 9/10: IV = SHA-256(Kassen-ID ‖ Belegnummer)[0..15], AES-256-ICM, N Byte Zweierkomplement big-endian.

    `belegnummer` ist der TEXT aus dem Beleg: Die Spezifikation kennt auch alphanumerische Belegnummern
    (das BMF-Beispiel nutzt „CASHBOX-DEMO-1-Receipt-ID-1")."""
    if not 1 <= len(chiffre) <= 16:
        raise ValueError("Länge des verschlüsselten Zählers %d Byte (erwartet 1..16)" % len(chiffre))
    iv = sha256(kassen_id + belegnummer)[:16]
    strom = aes256_block_verschluesseln(aes_schluessel, iv)
    klar = bytes(c ^ k for c, k in zip(chiffre, strom))
    return int.from_bytes(klar, "big", signed=True)


# ---------------------------------------------------------------------------
# ECDSA P-256 (nur Prüfen), Jacobi-Koordinaten
# ---------------------------------------------------------------------------

_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
_GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5


def _verdoppeln(pt):
    if pt is None:
        return None
    x, y, z = pt
    if y == 0:
        return None
    delta = z * z % _P
    gamma = y * y % _P
    beta = x * gamma % _P
    alpha = 3 * (x - delta) * (x + delta) % _P
    x3 = (alpha * alpha - 8 * beta) % _P
    z3 = ((y + z) ** 2 - gamma - delta) % _P
    y3 = (alpha * (4 * beta - x3) - 8 * gamma * gamma) % _P
    return (x3, y3, z3)


def _addieren(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1, z1 = p1
    x2, y2, z2 = p2
    z1z1 = z1 * z1 % _P
    z2z2 = z2 * z2 % _P
    u1 = x1 * z2z2 % _P
    u2 = x2 * z1z1 % _P
    s1 = y1 * z2 * z2z2 % _P
    s2 = y2 * z1 * z1z1 % _P
    h = (u2 - u1) % _P
    r = 2 * (s2 - s1) % _P
    if h == 0:
        return _verdoppeln(p1) if r == 0 else None
    i = (2 * h) ** 2 % _P
    j = h * i % _P
    v = u1 * i % _P
    x3 = (r * r - j - 2 * v) % _P
    y3 = (r * (v - x3) - 2 * s1 * j) % _P
    z3 = (((z1 + z2) ** 2 - z1z1 - z2z2) * h) % _P
    return (x3, y3, z3)


def _zu_affin(pt):
    if pt is None:
        return None
    x, y, z = pt
    zi = pow(z, -1, _P)
    zi2 = zi * zi % _P
    return (x * zi2 % _P, y * zi2 * zi % _P)


def ecdsa_p256_pruefen(qx, qy, nachricht, r, s):
    """Prüft eine ECDSA-Signatur (SHA-256) über `nachricht` (bytes) mit dem öffentlichen Punkt (qx, qy)."""
    if not (1 <= r < _N and 1 <= s < _N):
        return False
    if (qy * qy - (qx ** 3 - 3 * qx + _B)) % _P != 0 or not (0 <= qx < _P and 0 <= qy < _P):
        return False   # Punkt liegt nicht auf der Kurve
    e = int.from_bytes(sha256(nachricht), "big")
    w = pow(s, -1, _N)
    u1 = e * w % _N
    u2 = r * w % _N
    g = (_GX, _GY, 1)
    q = (qx, qy, 1)
    gq = _addieren(g, q)
    ergebnis = None
    for bit in range(255, -1, -1):
        ergebnis = _verdoppeln(ergebnis)
        b1 = (u1 >> bit) & 1
        b2 = (u2 >> bit) & 1
        if b1 and b2:
            ergebnis = _addieren(ergebnis, gq)
        elif b1:
            ergebnis = _addieren(ergebnis, g)
        elif b2:
            ergebnis = _addieren(ergebnis, q)
    affin = _zu_affin(ergebnis)
    return affin is not None and affin[0] % _N == r


# ---------------------------------------------------------------------------
# Minimaler DER-Leser: Zertifikat (X.509) und SubjectPublicKeyInfo
# ---------------------------------------------------------------------------


def _der(buf, pos):
    """Liest ein TLV an `pos`: (Tag, Beginn des Inhalts, Ende des Inhalts)."""
    tag = buf[pos]
    laenge = buf[pos + 1]
    pos += 2
    if laenge & 0x80:
        n = laenge & 0x7F
        laenge = int.from_bytes(buf[pos:pos + n], "big")
        pos += n
    return tag, pos, pos + laenge


def _kinder(buf, beginn, ende):
    pos = beginn
    while pos < ende:
        tag, b, e = _der(buf, pos)
        yield tag, b, e
        pos = e


def oeffentlicher_punkt_aus_spki(spki):
    """SubjectPublicKeyInfo (DER) → (x, y) einer P-256-Kurve."""
    tag, b, e = _der(spki, 0)
    if tag != 0x30:
        raise ValueError("SubjectPublicKeyInfo ist keine SEQUENCE")
    teile = list(_kinder(spki, b, e))
    if len(teile) < 2 or teile[1][0] != 0x03:
        raise ValueError("SubjectPublicKeyInfo ohne BIT STRING")
    alg = spki[teile[0][1]:teile[0][2]]
    if b"\x2a\x86\x48\xce\x3d\x02\x01" not in alg or b"\x2a\x86\x48\xce\x3d\x03\x01\x07" not in alg:
        raise ValueError("Schlüssel ist nicht ECDSA P-256 (prime256v1)")
    punkt = spki[teile[1][1] + 1:teile[1][2]]     # erstes Byte = ungenutzte Bits
    if len(punkt) != 65 or punkt[0] != 0x04:
        raise ValueError("Öffentlicher Schlüssel nicht im unkomprimierten Format (65 Byte)")
    return int.from_bytes(punkt[1:33], "big"), int.from_bytes(punkt[33:65], "big")


def zertifikat_lesen(der):
    """X.509-Zertifikat (DER) → (Seriennummer als int, SPKI-Bytes)."""
    tag, b, e = _der(der, 0)
    if tag != 0x30:
        raise ValueError("Zertifikat ist keine SEQUENCE")
    tbs_tag, tb, te = next(iter(_kinder(der, b, e)))
    felder = list(_kinder(der, tb, te))
    i = 0
    if felder[0][0] == 0xA0:       # [0] version
        i = 1
    serie = int.from_bytes(der[felder[i][1]:felder[i][2]], "big")
    # TBSCertificate: serial, signature, issuer, validity, subject, subjectPublicKeyInfo
    spki_tag, sb, se = felder[i + 5]
    # Beginn des TLV (Kopf) der SPKI finden: Kopf liegt vor `sb`
    kopf = 2
    laenge_roh = se - sb
    if laenge_roh >= 128:
        kopf = 2 + (1 if laenge_roh < 256 else 2)
    return serie, der[sb - kopf:se]


# ---------------------------------------------------------------------------
# Prüfung
# ---------------------------------------------------------------------------

BETRAG = re.compile(r"^-?\d+,\d{2}$")
DATUM = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$")
SUITE = re.compile(r"^R1-[A-Z]{2}\d{1,3}$")


def betrag_cent(text):
    vorzeichen = -1 if text.startswith("-") else 1
    euro, cent = text.lstrip("-").split(",")
    return vorzeichen * (int(euro) * 100 + int(cent))


class Pruefer(object):
    def __init__(self, aes_schluessel, schluesselkarte, ignoriere=(), erster_beleg=1, maximal=500):
        self.aes = aes_schluessel
        self.karte = schluesselkarte
        self.ignoriere = set(ignoriere)
        self.erster_beleg = erster_beleg
        self.maximal = maximal
        self.verstoesse = []
        self.zaehler_regeln = {}
        self.geprueft = 0
        self.signaturen = 0
        self.ausfallbelege = 0
        self.marker = {"TRA": 0, "STO": 0}
        self._schluessel_cache = {}

    def melde(self, nr, regel, detail):
        if regel in self.ignoriere:
            return
        self.zaehler_regeln[regel] = self.zaehler_regeln.get(regel, 0) + 1
        if len(self.verstoesse) < self.maximal:
            self.verstoesse.append({"beleg": nr, "regel": regel, "detail": detail})

    # -- Schlüssel ---------------------------------------------------------------------------------------------

    def _punkt_aus_eintrag(self, eintrag):
        daten = b64_decode(eintrag["signatureCertificateOrPublicKey"])
        if eintrag.get("signatureDeviceType") == "PUBLIC_KEY":
            return None, oeffentlicher_punkt_aus_spki(daten)
        serie, spki = zertifikat_lesen(daten)
        return serie, oeffentlicher_punkt_aus_spki(spki)

    def schluessel_fuer(self, zksn, gruppen_zertifikat):
        """Liefert (Seriennummer des Zertifikats oder None, Punkt) oder None."""
        cache_key = (zksn, gruppen_zertifikat)
        if cache_key in self._schluessel_cache:
            return self._schluessel_cache[cache_key]
        treffer = None
        eintrag = self.karte.get(zksn)
        if eintrag is None:
            for k, v in self.karte.items():
                if k.lower() == zksn.lower():
                    eintrag = v
                    break
        if eintrag is not None:
            treffer = self._punkt_aus_eintrag(eintrag)
        elif gruppen_zertifikat:
            serie, spki = zertifikat_lesen(b64_decode(gruppen_zertifikat))
            treffer = (serie, oeffentlicher_punkt_aus_spki(spki))
        self._schluessel_cache[cache_key] = treffer
        return treffer

    # -- Hauptprüfung ------------------------------------------------------------------------------------------

    def pruefe(self, gruppen):
        vorheriger_jws = None
        vorherige_nr = None
        vorheriges_datum = None
        kassen_id = None
        summe = 0
        for gruppe in gruppen:
            zert = gruppe.get("Signaturzertifikat") or ""
            for jws in gruppe.get("Belege-kompakt", []):
                self.geprueft += 1
                nr = self.geprueft          # laufende Nummer im Export (1-basiert) für die Meldungen
                ergebnis = self._beleg(nr, jws, zert, vorheriger_jws, vorherige_nr, vorheriges_datum, kassen_id, summe)
                if ergebnis is None:
                    vorheriger_jws = jws
                    vorherige_nr = None
                    continue
                kassen_id, vorherige_nr, vorheriges_datum, summe = ergebnis
                vorheriger_jws = jws
        return self

    def _beleg(self, lfd, jws, gruppen_zert, vorheriger_jws, vorherige_nr, vorheriges_datum, kassen_id, summe):
        teile = jws.split(".")
        if len(teile) != 3:
            self.melde(lfd, "jws-format", "kein JWS Compact (%d Teile)" % len(teile))
            return None
        try:
            header = json.loads(b64url_decode(teile[0]).decode("utf-8"))
            nutzlast = b64url_decode(teile[1]).decode("utf-8")
            signatur = b64url_decode(teile[2])
        except Exception as fehler:                      # noqa: BLE001 — jede Dekodierungsstörung ist ein Befund
            self.melde(lfd, "jws-format", "Teile nicht dekodierbar: %s" % fehler)
            return None
        if header != {"alg": "ES256"}:
            self.melde(lfd, "jws-format", "Header %s statt {\"alg\":\"ES256\"}" % json.dumps(header))
        if not nutzlast.startswith("_R1-"):
            self.melde(lfd, "jws-format", "Nutzlast beginnt nicht mit _R1-")
            return None

        felder = nutzlast.split("_")
        if len(felder) != 13 or felder[0] != "":
            self.melde(lfd, "code-format", "%d Felder statt 13 (erstes leer)" % len(felder))
            return None
        _, suite, kid, bnr_text, bdt, b_normal, b_e1, b_e2, b_null, b_bes, zaehler_b64, zksn, vorbeleg = felder
        if not SUITE.match(suite):
            self.melde(lfd, "code-format", "Algorithmuskennzeichen %r" % suite)
        # Belegnummer: beliebiger Text, der auf eine laufende Zahl endet (nur Ziffern in unserer Kassa; das BMF-Beispiel
        # nutzt „<Kasse>-Receipt-ID-<n>"). Fortlaufend heißt: gleicher Vorspann, Zahl + 1.
        nr_teile = re.match(r"^(.*?)(\d+)$", bnr_text)
        if not nr_teile:
            self.melde(lfd, "code-format", "Belegnummer %r endet nicht auf eine Zahl" % bnr_text)
            return None
        bnr = (nr_teile.group(1), int(nr_teile.group(2)))
        datum = DATUM.match(bdt)
        if not datum:
            self.melde(lfd, "code-format", "Datum %r nicht JJJJ-MM-TTThh:mm:ss" % bdt)
        betraege = [b_normal, b_e1, b_e2, b_null, b_bes]
        schlecht = [b for b in betraege if not BETRAG.match(b)]
        if schlecht:
            self.melde(lfd, "code-format", "Betrag mit falschem Format: %s" % ", ".join(schlecht))
            return None
        betrag = sum(betrag_cent(b) for b in betraege)

        # Kassen-ID, Belegnummer, Zeit
        if kassen_id is None:
            kassen_id = kid
        elif kid != kassen_id:
            self.melde(lfd, "kassen-id", "%r statt %r" % (kid, kassen_id))
        if vorherige_nr is not None:
            if bnr != (vorherige_nr[0], vorherige_nr[1] + 1):
                self.melde(lfd, "belegnummer", "Beleg %s, erwartet %s%d" % (bnr_text, vorherige_nr[0], vorherige_nr[1] + 1))
        elif lfd == 1 and bnr[0] == "" and self.erster_beleg is not None and bnr[1] != self.erster_beleg:
            self.melde(lfd, "belegnummer", "erster Beleg ist %s, erwartet %d" % (bnr_text, self.erster_beleg))
        zeit = bdt if datum else None
        if zeit and vorheriges_datum and zeit < vorheriges_datum:   # ISO-Zeichenketten sind lexikografisch geordnet
            self.melde(lfd, "zeit-rueckwaerts", "%s liegt vor %s (bei Zeitumstellung im Herbst ggf. erklärbar)" % (zeit, vorheriges_datum))

        # Verkettung (RKSV Anlage 1 Z 4): Hash über die JWS-Compact-Form des Vorbelegs bzw. die Kassen-ID
        if vorheriger_jws is not None:
            soll_vor = base64.b64encode(sha256(vorheriger_jws)[:8]).decode("ascii")
            if vorbeleg != soll_vor:
                self.melde(lfd, "verkettung", "Sig-Voriger-Beleg %s statt %s" % (vorbeleg, soll_vor))
        else:       # erster Beleg des Exports: der Startbeleg trägt den Hash der Kassen-ID
            soll_vor = base64.b64encode(sha256(kid)[:8]).decode("ascii")
            if vorbeleg != soll_vor:
                self.melde(lfd, "verkettung", "Startbeleg: Sig-Voriger-Beleg %s statt %s (Kassen-ID)" % (vorbeleg, soll_vor))

        # Signatur
        ausfall = False
        try:
            ausfall = signatur.decode("utf-8") == AUSFALL_TEXT
        except UnicodeDecodeError:
            ausfall = False
        zert_serie = None
        if ausfall:
            self.ausfallbelege += 1
        else:
            try:
                schluessel = self.schluessel_fuer(zksn, gruppen_zert)
            except Exception as fehler:                  # noqa: BLE001
                schluessel = None
                self.melde(lfd, "schluessel-fehlt", "Zertifikat/Schlüssel zu %r nicht lesbar: %s" % (zksn, fehler))
            else:
                if schluessel is None:
                    self.melde(lfd, "schluessel-fehlt", "kein Zertifikat/Schlüssel zu Seriennummer %r" % zksn)
            if schluessel is not None:
                zert_serie, punkt = schluessel
                if len(signatur) != 64:
                    self.melde(lfd, "signatur", "Signatur %d Byte statt 64 (r‖s)" % len(signatur))
                else:
                    eingabe = (teile[0] + "." + teile[1]).encode("ascii")
                    r = int.from_bytes(signatur[:32], "big")
                    s = int.from_bytes(signatur[32:], "big")
                    self.signaturen += 1
                    if not ecdsa_p256_pruefen(punkt[0], punkt[1], eingabe, r, s):
                        self.melde(lfd, "signatur", "ES256-Signatur passt nicht zum Zertifikat/Schlüssel %s" % zksn)
        if zert_serie is not None and re.match(r"^[0-9A-Fa-f]+$", zksn):
            if int(zksn, 16) != zert_serie:
                self.melde(lfd, "zertifikat-sn", "%s ≠ Seriennummer des Zertifikats %X" % (zksn, zert_serie))

        # Umsatzzähler
        try:
            chiffre = b64_decode(zaehler_b64)
        except Exception:                                # noqa: BLE001
            self.melde(lfd, "code-format", "Umsatzzähler %r ist kein gültiges Base64" % zaehler_b64)
            return kassen_id, bnr, zeit, summe + betrag
        if chiffre in (b"TRA", b"STO"):
            # Klartext-Marker der BMF-Beispieldaten: Training zählt nicht, Storno schon
            marke = chiffre.decode("ascii")
            self.marker[marke] += 1
            return kassen_id, bnr, zeit, (summe + betrag) if marke == "STO" else summe
        summe += betrag
        try:
            echt = umsatzzaehler_entschluesseln(chiffre, self.aes, kid, bnr_text)
        except Exception as fehler:                      # noqa: BLE001
            self.melde(lfd, "umsatzzaehler", "nicht entschlüsselbar: %s" % fehler)
            return kassen_id, bnr, zeit, summe
        if echt != summe:
            self.melde(lfd, "umsatzzaehler", "entschlüsselt %d, erwartet %d (Differenz %d)" % (echt, summe, echt - summe))
            summe = echt          # ab hier dem Wert der Kasse folgen, damit EIN Fehler nicht alle Folgebelege rot färbt
        return kassen_id, bnr, zeit, summe

    def bericht(self):
        return {
            "geprueft": self.geprueft,
            "signaturenGeprueft": self.signaturen,
            "ausfallbelege": self.ausfallbelege,
            "marker": self.marker,
            "verstoesseGesamt": sum(self.zaehler_regeln.values()),
            "verstoesseJeRegel": self.zaehler_regeln,
            "verstoesse": self.verstoesse,
        }


# ---------------------------------------------------------------------------
# Selbsttest (bekannte Antworten) — läuft vor jeder Prüfung mit --selbsttest, im Test automatisch
# ---------------------------------------------------------------------------


def selbsttest():
    fehler = []
    # AES-256, FIPS-197 Anhang C.3
    schluessel = bytes(range(32))
    klar = bytes.fromhex("00112233445566778899aabbccddeeff")
    if aes256_block_verschluesseln(schluessel, klar).hex() != "8ea2b7ca516745bfeafc49904b496089":
        fehler.append("AES-256 weicht vom FIPS-197-Testvektor ab")
    if _SBOX[0x00] != 0x63 or _SBOX[0x01] != 0x7C or _SBOX[0x53] != 0xED:
        fehler.append("AES-S-Box falsch")
    # ECDSA P-256: Signaturen, die OpenSSL (über Node crypto) erzeugt hat — gültig muss gelten, jede Veränderung nicht
    for name, (x, y, nachricht, r, s) in _ECDSA_VEKTOREN.items():
        if not ecdsa_p256_pruefen(x, y, nachricht, r, s):
            fehler.append("ECDSA-Vektor %s wird nicht akzeptiert" % name)
        if ecdsa_p256_pruefen(x, y, nachricht + b"!", r, s):
            fehler.append("ECDSA-Vektor %s: veränderte Nachricht wird akzeptiert" % name)
        if ecdsa_p256_pruefen(x, y, nachricht, r, s ^ 1):
            fehler.append("ECDSA-Vektor %s: veränderte Signatur wird akzeptiert" % name)
        if ecdsa_p256_pruefen(x, (y + 1) % _P, nachricht, r, s):
            fehler.append("ECDSA-Vektor %s: Punkt außerhalb der Kurve wird akzeptiert" % name)
    return fehler


# (x, y, Nachricht, r, s) — erzeugt mit crypto.sign('sha256', …, {dsaEncoding: 'ieee-p1363'}) in Node/OpenSSL
_ECDSA_VEKTOREN = {
    "openssl-1": (0x0d334b42af6eb89e9ebd4c871727e60c58111310b08cdc9ee5868b36046dcccf,
                  0x9f284502e06ca708e92686fa1c4db45db0478ac2eb05e27dc6abcbffc1e78a8c,
                  b"RKSV Zweitpruefer Testvektor 1",
                  0xcc8573577d6ea4c959ebe62e6a407568af218a5c3887961a46223bf80fad7e59,
                  0x6ec0f1ba5de1ecdd6dc0c9c7f702c9b5ca8e85b6cb78fd3d9e8b80187f331cd8),
    "openssl-2": (0x4d58389c3f2ffcd94a4a35df4e5bf874b0694e9d6858381f0ad343df3ccda917,
                  0xbc4315eba10cba10804aca09f639b44b2a510cfae66916893a3d694edfe981bd,
                  b"eyJhbGciOiJFUzI1NiJ9.X1IxLUFUMF9LQVNTRS0xXzFf",
                  0xf0c2a3095780ea8d156c07d3d72f15b29855949def5302ff205b16c144e466c0,
                  0xfa61272dd9d9d7b8b9e972749c05ebfa99d21e2125da9b7201dc414aad25b1de),
}


# ---------------------------------------------------------------------------
# Kommandozeile
# ---------------------------------------------------------------------------


def _laden(pfad):
    with open(pfad, "r", encoding="utf-8") as datei:
        return json.load(datei)


def main(argv=None):
    # Konsolen mit Windows-Codepage (cp1252) vertragen „‖", „≠" in den Meldungen nicht
    for strom in (sys.stdout, sys.stderr):
        if hasattr(strom, "reconfigure"):
            strom.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Unabhängiger RKSV-Prüfer für DEP7-Exporte (nur Standardbibliothek)")
    ap.add_argument("--dep7")
    ap.add_argument("--crypto")
    ap.add_argument("--bericht", help="Bericht als JSON schreiben")
    ap.add_argument("--ignoriere", default="", help="Regeln, die nicht als Verstoß zählen (Komma-getrennt)")
    ap.add_argument("--erster-beleg", type=int, default=1, help="Belegnummer des ersten Belegs im Export (Standard 1)")
    ap.add_argument("--maximal", type=int, default=500, help="höchstens so viele Verstöße im Bericht")
    ap.add_argument("--selbsttest", action="store_true")
    args = ap.parse_args(argv)

    if args.selbsttest:
        probleme = selbsttest()
        for p in probleme:
            print("SELBSTTEST FEHLGESCHLAGEN: " + p, file=sys.stderr)
        if not probleme:
            print("Selbsttest ok (AES-256 FIPS-197, ECDSA P-256)")
        return 2 if probleme else 0

    if not args.dep7 or not args.crypto:
        ap.error("--dep7 und --crypto sind Pflicht (oder --selbsttest)")

    probleme = selbsttest()
    if probleme:
        print("Selbsttest fehlgeschlagen — Prüfung abgebrochen: " + "; ".join(probleme), file=sys.stderr)
        return 2
    try:
        dep7 = _laden(args.dep7)
        crypto = _laden(args.crypto)
        aes = b64_decode(crypto["base64AESKey"])
        karte = crypto.get("certificateOrPublicKeyMap", {})
        gruppen = dep7["Belege-Gruppe"]
    except Exception as fehler:                           # noqa: BLE001
        print("Eingabe unbrauchbar: %s" % fehler, file=sys.stderr)
        return 2

    p = Pruefer(aes, karte, [r for r in args.ignoriere.split(",") if r], args.erster_beleg, args.maximal).pruefe(gruppen)
    bericht = p.bericht()
    if args.bericht:
        with open(args.bericht, "w", encoding="utf-8") as datei:
            json.dump(bericht, datei, ensure_ascii=False, indent=2)
    print("Zweitprüfer: %d Belege, %d Signaturen geprüft, %d Ausfallbelege, %d Verstöße" % (
        bericht["geprueft"], bericht["signaturenGeprueft"], bericht["ausfallbelege"], bericht["verstoesseGesamt"]))
    for regel, anzahl in sorted(bericht["verstoesseJeRegel"].items()):
        beispiel = next((v for v in bericht["verstoesse"] if v["regel"] == regel), None)
        print("  %-18s %5d   z. B. Beleg %s: %s" % (regel, anzahl, beispiel["beleg"] if beispiel else "?", beispiel["detail"] if beispiel else ""))
    return 1 if bericht["verstoesseGesamt"] else 0


if __name__ == "__main__":
    sys.exit(main())
