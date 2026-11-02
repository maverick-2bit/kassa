/**
 * Tischnummer aus öffentlichen Routen (Gast-Bestellung, Selbstbedienungs-Kasse).
 *
 * Der Wert kommt aus dem Tisch-QR — und damit von jedem, der die Adresse ändert. Er landet auf Bons,
 * im Küchenbildschirm und im Tisch-Tab. Erlaubt ist jeder sichtbare Text (Tische heißen „Tisch 5",
 * „Terrasse 3", „Bar-2/Ecke" …); nicht erlaubt sind Steuer- und Formatzeichen (Zeilenumbrüche,
 * ESC/GS, Rechts-nach-links-Umschalter …) sowie Zeichen, die HTML oder Befehlszeilen einleiten
 * könnten. Der ESC/POS-Encoder entfernt Steuerzeichen zusätzlich (services/escpos/commands.ts) —
 * das hier ist die erste Linie, sodass fremde Eingaben gar nicht erst gespeichert werden.
 */

import { z } from 'zod'

export const TischNummerSchema = z.string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{C}<>`\\]+$/u, 'Ungültige Zeichen in der Tischnummer')
