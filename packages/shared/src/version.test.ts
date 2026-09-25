import { describe, it, expect } from 'vitest'
import { istNeuereVersion, istNeuererServiceWorker } from './version.js'

describe('istNeuereVersion', () => {
  it('vergleicht numerisch je Stelle, nicht als Text', () => {
    expect(istNeuereVersion('0.8.10', '0.8.9')).toBe(true)
    expect(istNeuereVersion('0.10.0', '0.9.99')).toBe(true)
    expect(istNeuereVersion('1.0.0', '0.8.7')).toBe(true)
  })

  it('gleich oder älter ist nicht neuer', () => {
    expect(istNeuereVersion('0.8.7', '0.8.7')).toBe(false)
    expect(istNeuereVersion('0.8.6', '0.8.7')).toBe(false)
    expect(istNeuereVersion('0.8', '0.8.0')).toBe(false)
  })

  it('ungültige Teile zählen als 0', () => {
    expect(istNeuereVersion('dev', '0.0.0')).toBe(false)
    expect(istNeuereVersion('0.8.7', 'dev')).toBe(true)
  })
})

describe('istNeuererServiceWorker', () => {
  const url = (v: string) => `https://kellner.example/sw.js?v=${v}`

  it('SW einer neueren Version → Update-Hinweis', () => {
    expect(istNeuererServiceWorker(url('0.8.8'), '0.8.7')).toBe(true)
  })

  it('SW der eigenen oder einer älteren Version → kein Hinweis', () => {
    expect(istNeuererServiceWorker(url('0.8.7'), '0.8.7')).toBe(false)
    expect(istNeuererServiceWorker(url('0.8.6'), '0.8.7')).toBe(false)
  })

  it('ohne Controller, ohne ?v= oder mit kaputter URL → kein Hinweis', () => {
    expect(istNeuererServiceWorker(undefined, '0.8.7')).toBe(false)
    expect(istNeuererServiceWorker('https://kellner.example/sw.js', '0.8.7')).toBe(false)
    expect(istNeuererServiceWorker('kein url', '0.8.7')).toBe(false)
  })
})
