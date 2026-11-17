import { useTranslation } from "react-i18next";
import { parseContractFees, serializeContractFees } from "@mep/core";
import { useContractsByProject } from "../../repositories/contracts";
import { MoneyInput } from "../../components/MoneyInput";
import { useFormat } from "../../lib/format";

/**
 * Optional fee per contract for one assignment.
 *
 * Leave a contract empty and it shares what is left of the agreed amount in
 * proportion to its value, exactly as before. Fill it in and that contract's
 * payment stages split precisely that fee, so round fees give round stages.
 * Keyed by contract number (see stageAllocation.ts in @mep/core).
 */
export function ContractFeesEditor({
  projectId,
  currency,
  agreedMinor,
  value,
  onChange,
}: {
  projectId: number;
  currency: string;
  agreedMinor: number;
  /** Contract number -> fee in minor units. */
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: contracts = [] } = useContractsByProject(projectId);

  // One fee per contract only makes sense when there is more than one.
  if (projectId === 0 || contracts.length < 2) return null;

  const fixed = contracts.reduce((sum, c) => sum + (value[c.number] ?? 0), 0);
  const difference = agreedMinor - fixed;

  return (
    <div className="col-span-2 rounded-md border border-border p-3">
      <div className="text-sm font-medium">{t("people.contractFees")}</div>
      <p className="mb-2 text-xs text-muted">{t("people.contractFeesHint")}</p>
      <div className="grid grid-cols-2 gap-2">
        {contracts.map((contract) => (
          <label key={contract.id} className="flex flex-col gap-1 text-xs">
            <span>
              {contract.number}
              {contract.title ? ` · ${contract.title}` : ""}
            </span>
            <MoneyInput
              currency={currency}
              valueMinor={value[contract.number] ?? null}
              onChange={(minor) => {
                const next = { ...value };
                if (minor === null || minor === 0) delete next[contract.number];
                else next[contract.number] = minor;
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
      {fixed > 0 && difference >= 0 && (
        <p className="mt-2 text-xs text-muted">
          {t("people.contractFeesRemainder", { amount: fmt.money(difference, currency) })}
        </p>
      )}
      {difference < 0 && (
        <p className="mt-2 text-xs text-red-600">
          {t("people.contractFeesOver", { amount: fmt.money(-difference, currency) })}
        </p>
      )}
    </div>
  );
}

/** Stored JSON text <-> editor value. */
export const contractFeesFromStored = parseContractFees;
export const contractFeesToStored = serializeContractFees;
