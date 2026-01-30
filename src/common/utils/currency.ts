/**
 * Converts a balance from base currency to the target currency using the conversion rate.
 * @param amount The amount in base currency.
 * @param rate The conversion rate to base (amount / rate = converted).
 * @returns The converted amount.
 */
export function convertBalance(amount: number | string, rate: number | string): number {
    const r = parseFloat(String(rate));
    const a = parseFloat(String(amount));
    return a / (r > 0 ? r : 1);
}

/**
 * Converts an amount from user currency to base currency.
 * @param amount The amount in user currency.
 * @param rate The conversion rate to base (1 Unit = Rate * Base? No. Rate to Base usually means 1 Currency = Rate Base).
 * Based on previous logic: Base = User * Rate.
 * @returns The amount in base currency.
 */
export function convertToBase(amount: number | string, rate: number | string): number {
    const r = parseFloat(String(rate));
    const a = parseFloat(String(amount));
    return a * (r > 0 ? r : 1);
}
