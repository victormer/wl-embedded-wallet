import type { UserOperationJson, VaultCall } from '@wl-embedded-wallet/core/operations';
import { decodeFunctionData, erc20Abi, formatEther, maxUint256 } from 'viem';
import { Row } from './sign-review';
import { Note } from './ui';

type Erc20Call = { name: 'transfer' | 'approve'; target: `0x${string}`; amount: bigint };

/** The data as an ERC-20 `transfer` or `approve` when its selector and arguments match exactly; `null` otherwise. */
export function decodeErc20(data: `0x${string}` | undefined): Erc20Call | null {
  if (!data || data === '0x') return null;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== 'transfer' && decoded.functionName !== 'approve') return null;
    const [target, amount] = decoded.args as readonly [`0x${string}`, bigint];
    return { name: decoded.functionName, target, amount };
  } catch {
    return null;
  }
}

/** Gas limits times the maximum fee: the most the network fee can be. A paymaster pays it when sponsored. */
export function maxNetworkFee(operation: UserOperationJson): bigint {
  const gas =
    BigInt(operation.callGasLimit) +
    BigInt(operation.verificationGasLimit) +
    BigInt(operation.preVerificationGas) +
    BigInt(operation.paymasterVerificationGasLimit ?? '0') +
    BigInt(operation.paymasterPostOpGasLimit ?? '0');
  return gas * BigInt(operation.maxFeePerGas);
}

/** What the call does, as the vault will execute it: recipient, amount in the native currency, data raw and decoded. */
export function TransactionCallReview({ call, nativeCurrency }: { call: VaultCall; nativeCurrency: string }) {
  const erc20 = decodeErc20(call.data);
  return (
    <>
      <div className="field">
        <span className="label">To</span>
        <code className="value" data-testid="tx-to">
          {call.to}
        </code>
      </div>
      <Row label="Amount" testId="tx-value">
        {formatEther(BigInt(call.value))} {nativeCurrency}
      </Row>
      <div className="field">
        <span className="label">Data</span>
        {call.data ? (
          <pre className="value value-pre" data-testid="tx-data">
            {call.data}
          </pre>
        ) : (
          <span className="value value-empty" data-testid="tx-data">
            No data
          </span>
        )}
      </div>
      {erc20 && (
        <div className="field" data-testid="tx-decoded" data-function={erc20.name}>
          <span className="label">{erc20.name === 'transfer' ? 'Decoded: ERC-20 transfer' : 'Decoded: ERC-20 approval'}</span>
          <dl className="call">
            <dt className="label">Token contract</dt>
            <dd>
              <code className="value">{call.to}</code>
            </dd>
            <dt className="label">{erc20.name === 'transfer' ? 'Recipient' : 'Spender'}</dt>
            <dd>
              <code className="value" data-testid="tx-decoded-target">
                {erc20.target}
              </code>
            </dd>
            <dt className="label">Amount (token base units)</dt>
            <dd>
              <span className="value" data-testid="tx-decoded-amount">
                {erc20.name === 'approve' && erc20.amount === maxUint256 ? 'Unlimited' : erc20.amount.toString()}
              </span>
            </dd>
          </dl>
        </div>
      )}
      {erc20?.name === 'approve' && (
        <Note tone="caution" data-testid="tx-approve-warning">
          This lets the spender move your tokens later, without asking again. Approve it only if you trust the app.
        </Note>
      )}
      {call.data && !erc20 && (
        <Note tone="caution" data-testid="tx-data-warning">
          This transaction calls a contract and the vault does not decode its data. Send it only if you trust the app.
        </Note>
      )}
    </>
  );
}

/** "Sponsored", or the maximum network fee paid from the Safe's balance. */
export function TransactionCost({ operation, nativeCurrency }: { operation: UserOperationJson; nativeCurrency: string }) {
  const sponsored = Boolean(operation.paymaster);
  return (
    <>
      <Note data-testid="tx-cost" data-sponsored={String(sponsored)}>
        {sponsored ? "Sponsored: this network's paymaster pays the network fee." : `Not sponsored: the network fee is paid in ${nativeCurrency} from your Safe's balance.`}
      </Note>
      {!sponsored && (
        <div className="field">
          <span className="label">Maximum network fee</span>
          <code className="value" data-testid="tx-max-fee">
            {formatEther(maxNetworkFee(operation))} {nativeCurrency}
          </code>
        </div>
      )}
    </>
  );
}
