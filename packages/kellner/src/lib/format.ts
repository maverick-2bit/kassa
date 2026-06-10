export function formatPreis(cent: number): string {
  return `€ ${(cent / 100).toFixed(2).replace('.', ',')}`
}
