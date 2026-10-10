const MONEY_SCALE = 10n ** 24n;
export function decimal(value: string | number) {
  const raw = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) throw new Error('Invalid decimal');
  const exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 100 || raw.length > 120)
    throw new Error('Decimal outside supported range');
  const digits = match[1] + (match[2] ?? '');
  const scale = (match[2]?.length ?? 0) - exponent;
  if (scale <= 0) return BigInt(digits + '0'.repeat(-scale)).toString();
  const padded = digits.padStart(scale + 1, '0');
  const integer = BigInt(padded.slice(0, -scale)).toString();
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}
export function moneyUnits(value: string) {
  const [integer, fraction = ''] = decimal(value).split('.');
  if (fraction.length > 24) throw new Error('More than 24 decimal places');
  return BigInt(integer) * MONEY_SCALE + BigInt(fraction.padEnd(24, '0'));
}
export function moneyString(units: bigint) {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const fraction = (abs % MONEY_SCALE).toString().padStart(24, '0').replace(/0+$/, '');
  return `${sign}${abs / MONEY_SCALE}${fraction ? `.${fraction}` : ''}`;
}
/** `quantity` at `price` per `unit`, rounded half up, in exact money units. */
export function chargeUnits(quantity: string, price: string, unit: number) {
  const denominator = BigInt(unit);
  return (BigInt(quantity) * moneyUnits(price) + denominator / 2n) / denominator;
}
export function charge(quantity: string, price: string, unit: number) {
  return moneyString(chargeUnits(quantity, price, unit));
}
