import { isAddress, parseEther } from 'viem';

export type TransactionForm = { to: string; value: string; data: string };
export type TransactionCall = { to: `0x${string}`; value: bigint; data?: `0x${string}` };

const AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * The demo form's call, or `null` if a field is not valid. The amount is in native units (18 decimals); empty data
 * or `0x` is a plain transfer.
 */
export function parseTransactionForm(form: TransactionForm): TransactionCall | null {
  const to = form.to.trim();
  const amount = form.value.trim();
  const data = form.data.trim();
  if (!isAddress(to, { strict: false })) return null;
  // More than 18 decimals would be rounded by `parseEther`, so it is not what the user typed.
  if (!AMOUNT.test(amount) || (amount.split('.')[1]?.length ?? 0) > 18) return null;
  let value: bigint;
  try {
    value = parseEther(amount);
  } catch {
    return null;
  }
  if (data !== '' && !HEX.test(data)) return null;
  return { to, value, ...(data !== '' && data !== '0x' ? { data: data as `0x${string}` } : {}) };
}
