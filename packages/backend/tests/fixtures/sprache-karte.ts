/**
 * Erfundene, aber realistische österreichische Gastro-Karte für die Tests der Sprachbestellung.
 * Mit Synonymen (Umgangssprache) und Modifikatoren (Beilagen, Garstufe, „ohne …").
 */

import type { SprachArtikel, SprachModifikator } from '../../src/services/sprache/index.js'

const mod = (id: string, gruppeId: string, name: string, synonyme?: string[]): SprachModifikator =>
  ({ id, gruppeId, name, ...(synonyme ? { synonyme } : {}) })

const BEILAGEN = [
  mod('m-pommes',  'g-beilage', 'Pommes'),
  mod('m-reis',    'g-beilage', 'Reis'),
  mod('m-petersil', 'g-beilage', 'Petersilkartoffeln', ['Petersilerdäpfel']),
]

const BURGER_MODS = [
  mod('m-medium',   'g-garstufe', 'Medium'),
  mod('m-durch',    'g-garstufe', 'Durch', ['Well Done']),
  mod('m-o-zwiebel', 'g-ohne',    'ohne Zwiebel'),
  mod('m-o-gurken',  'g-ohne',    'ohne Gurken'),
  mod('m-x-kaese',   'g-extras',  'extra Käse'),
]

export const KARTE: SprachArtikel[] = [
  // Getränke
  { id: 'bier05',  bezeichnung: 'Bier vom Fass 0,5l', synonyme: ['Bier', 'Krügerl', 'Halbe'] },
  { id: 'bier03',  bezeichnung: 'Bier vom Fass 0,3l', synonyme: ['Seidl', 'Seidel'] },
  { id: 'spritzer', bezeichnung: 'Weißer Spritzer', synonyme: ['Spritzer weiß', 'Gespritzter', 'Spritzer'] },
  { id: 'radler',  bezeichnung: 'Radler' },
  { id: 'cola',    bezeichnung: 'Cola 0,33l', synonyme: ['Cola', 'Coca Cola'] },
  { id: 'almdudler', bezeichnung: 'Almdudler 0,35l', synonyme: ['Almdudler'] },
  { id: 'apfelspritzer', bezeichnung: 'Apfelsaft gespritzt', synonyme: ['Apfelspritzer'] },
  { id: 'mineral-still', bezeichnung: 'Mineralwasser still' },
  { id: 'mineral-prickel', bezeichnung: 'Mineralwasser prickelnd', synonyme: ['Soda'] },
  { id: 'gin',     bezeichnung: 'Gin und Tonic' },
  { id: 'zweigelt', bezeichnung: 'Zweigelt Viertel', synonyme: ['Zweigelt'] },
  { id: 'veltliner', bezeichnung: 'Grüner Veltliner Viertel', synonyme: ['Veltliner'] },
  // Kaffee
  { id: 'melange', bezeichnung: 'Melange' },
  { id: 'verlaengerter', bezeichnung: 'Verlängerter' },
  { id: 'espresso', bezeichnung: 'Espresso', synonyme: ['Schwarzer'] },
  { id: 'cappuccino', bezeichnung: 'Cappuccino' },
  // Speisen
  { id: 'wschnitzel', bezeichnung: 'Wiener Schnitzel', modifikatoren: [...BEILAGEN, mod('m-o-zitrone', 'g-ohne', 'ohne Zitrone')] },
  { id: 'pschnitzel', bezeichnung: 'Putenschnitzel', modifikatoren: BEILAGEN },
  { id: 'burger',  bezeichnung: 'Burger', synonyme: ['Cheeseburger'], modifikatoren: BURGER_MODS },
  { id: 'pizza-m', bezeichnung: 'Pizza Margherita' },
  { id: 'pizza-s', bezeichnung: 'Pizza Salami' },
  { id: 'tafelspitz', bezeichnung: 'Tafelspitz' },
  { id: 'gulasch', bezeichnung: 'Gulaschsuppe' },
  { id: 'fritatten', bezeichnung: 'Frittatensuppe' },
  { id: 'schmarrn', bezeichnung: 'Kaiserschmarrn' },
  { id: 'strudel', bezeichnung: 'Apfelstrudel' },
  { id: 'sacher',  bezeichnung: 'Sachertorte' },
  { id: 'pommes',  bezeichnung: 'Pommes Frites', synonyme: ['Pommes'] },
]
