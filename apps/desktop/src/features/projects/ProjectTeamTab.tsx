import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, Users } from "lucide-react";
import type { AssignmentLifecycle } from "@mep/core";
import { assignmentSchema, type AssignmentInput } from "@mep/core";
import { type WorkspaceFinancials } from "../../repositories/financials";
import { usePeople, usePeopleMutations, type AssignmentListItem } from "../../repositories/people";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, SectionHeader, Select } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { useFormat } from "../../lib/format";
import { PersonForm } from "../people/PeoplePage";
import { readModelAmount, UNKNOWN_AMOUNT } from "./projectWorkspaceModel";

export function ProjectTeam({
  assignments,
  financials,
  financialsPending,
  onAdd,
}: {
  assignments: AssignmentListItem[];
  financials: WorkspaceFinancials | undefined;
  financialsPending: boolean;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const mutations = usePeopleMutations();
  const [cancelling, setCancelling] = useState<AssignmentListItem | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const accountOf = (assignmentId: number) =>
    financials?.teamAccounts.find(
      (account) => account.assignmentId === assignmentId,
    );
  const columns: Column<AssignmentListItem>[] = [
    {
      key: "person",
      header: t("time.person"),
      value: (assignment) => assignment.personName,
      render: (assignment) => (
        <span className="font-medium">{assignment.personName}</span>
      ),
    },
    {
      key: "scope",
      header: t("common.description"),
      value: (assignment) => assignment.scope,
    },
    {
      // Lifecycle answers what happened to the work; archiving is separate, so
      // an archived row still shows the lifecycle that governs its money.
      key: "lifecycle",
      header: t("common.status"),
      value: (assignment) => assignment.lifecycleStatus,
      render: (assignment) => (
        <div className="flex items-center gap-1.5">
          <Badge
            value={ASSIGNMENT_LIFECYCLE_TONE[assignment.lifecycleStatus]}
            label={t(`assignments.lifecycle.${assignment.lifecycleStatus}`)}
          />
          {assignment.archivedAt !== null && (
            <Badge value="CANCELLED" label={t("lifecycle.archived")} />
          )}
        </div>
      ),
    },
    {
      key: "agreed",
      header: t("people.agreedAmount"),
      value: (assignment) => assignment.agreedMinor,
      render: (assignment) =>
        fmt.money(assignment.agreedMinor, assignment.currency, {
          compactFraction: true,
        }),
      align: "end",
    },
    // Payout figures belong to the audited read model. Until it resolves,
    // these columns show "unknown", never a fabricated zero balance.
    {
      key: "accrued",
      header: t("projects.teamAccrued"),
      value: (assignment) =>
        accountOf(assignment.id)?.accruedMinor ?? 0,
      render: (assignment) =>
        readModelAmount(accountOf(assignment.id), (account) =>
          fmt.money(account.accruedMinor, assignment.currency, {
            compactFraction: true,
          })),
      align: "end",
    },
    {
      key: "paid",
      header: t("people.paidToDate"),
      value: (assignment) => accountOf(assignment.id)?.paidMinor ?? 0,
      render: (assignment) =>
        readModelAmount(accountOf(assignment.id), (account) =>
          fmt.money(account.paidMinor, assignment.currency, {
            compactFraction: true,
          })),
      align: "end",
    },
    {
      key: "due",
      header: t("team.dueNow"),
      value: (assignment) => accountOf(assignment.id)?.dueMinor ?? 0,
      render: (assignment) => {
        const account = accountOf(assignment.id);
        if (!account) return <span className="text-muted">{UNKNOWN_AMOUNT}</span>;
        return account.dueMinor > 0 ? (
          <Badge
            tone="warning"
            label={fmt.money(account.dueMinor, assignment.currency, {
              compactFraction: true,
            })}
          />
        ) : (
          <span className="text-muted tnum">
            {fmt.money(0, assignment.currency, { compactFraction: true })}
          </span>
        );
      },
      align: "end",
    },
    {
      key: "lifecycleActions",
      header: "",
      sortable: false,
      width: "210px",
      render: (assignment) =>
        assignment.lifecycleStatus === "ACTIVE" ? (
          <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
            <Button
              variant="ghost"
              disabled={mutations.completeAssignment.isPending}
              onClick={() => mutations.completeAssignment.mutate(assignment.id)}
            >
              {t("assignments.complete")}
            </Button>
            <Button
              variant="ghost"
              className="!text-red-600"
              onClick={() => setCancelling(assignment)}
            >
              {t("assignments.cancel")}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <section>
      <SectionHeader
        title={t("projects.team")}
        actions={
          <Button variant="primary" onClick={onAdd}>
            <Plus size={15} aria-hidden="true" />
            {t("projects.addTeamMember")}
          </Button>
        }
      />
      {assignments.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={t("projects.emptyTeam")}
            description={t("projects.emptyTeamHint")}
            action={
              <Button variant="primary" onClick={onAdd}>
                <Plus size={15} aria-hidden="true" />
                {t("projects.addTeamMember")}
              </Button>
            }
          />
        </Card>
      ) : (
        <DataTable
          rows={assignments}
          columns={columns}
          rowKey={(assignment) => assignment.id}
          density="compact"
          loading={financialsPending}
          onRowClick={(assignment) =>
            navigate(`/team/people/${assignment.personId}`)
          }
        />
      )}

      {/* Cancelling drops the unearned commitment, so it records why. */}
      {cancelling && (
        <Modal title={t("assignments.cancelTitle")} onClose={() => setCancelling(null)}>
          <p className="mb-4 text-sm leading-6 text-muted">
            {t("assignments.cancelExplain", { person: cancelling.personName })}
          </p>
          <Field label={t("assignments.cancelReason")}>
            <Input
              autoFocus
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setCancelling(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              className="!bg-red-600 hover:!bg-red-700"
              disabled={!cancelReason.trim() || mutations.cancelAssignment.isPending}
              onClick={() =>
                mutations.cancelAssignment.mutate(
                  { id: cancelling.id, reason: cancelReason },
                  {
                    onSuccess: () => {
                      setCancelling(null);
                      setCancelReason("");
                    },
                  },
                )
              }
            >
              {t("assignments.cancel")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Badge tone per lifecycle, reusing the shared status palette. */
const ASSIGNMENT_LIFECYCLE_TONE: Record<AssignmentLifecycle, string> = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

/**
 * Assign a person to this project. Creating a person here also adds that
 * person to the shared Team directory.
 */
export function ProjectTeamForm({
  projectId,
  currency,
  fxRateMicro,
  onClose,
}: {
  projectId: number;
  currency: string;
  fxRateMicro: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: people = [] } = usePeople();
  const mutations = usePeopleMutations();

  const [personId, setPersonId] = useState(0);
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [agreedMinor, setAgreedMinor] = useState(0);
  const [scope, setScope] = useState("");
  const [error, setError] = useState("");

  function submit() {
    const parsed = assignmentSchema.safeParse({
      personId,
      projectId,
      agreedMinor,
      currency,
      fxRateMicro,
      scope: scope || null,
      progressNote: null,
    } satisfies AssignmentInput);
    if (!parsed.success) {
      setError(t("validation.required"));
      return;
    }
    mutations.createAssignment.mutate(parsed.data, { onSuccess: onClose });
  }

  return (
    <>
      <Modal title={t("projects.addTeamMember")} onClose={onClose}>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={t("people.selectPerson")}
            error={personId === 0 ? error : undefined}
            className="col-span-2"
          >
            <div className="flex gap-2">
              <Select
                className="flex-1"
                value={personId}
                onChange={(event) => setPersonId(Number(event.target.value))}
              >
                <option value={0}>—</option>
                {people
                  .filter((person) => person.isActive)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} ({t(`personType.${person.type}`)})
                    </option>
                  ))}
              </Select>
              <Button onClick={() => setCreatingPerson(true)}>
                {t("people.orCreateNew")}
              </Button>
            </div>
          </Field>
          <Field label={t("people.agreedAmount")}>
            <MoneyInput
              currency={currency}
              valueMinor={agreedMinor}
              onChange={(value) => setAgreedMinor(value ?? 0)}
            />
          </Field>
          <Field label={t("common.description")}>
            <Input
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={
              personId === 0 || mutations.createAssignment.isPending
            }
          >
            {t("common.save")}
          </Button>
        </div>
      </Modal>
      {creatingPerson && (
        <PersonForm
          initial={null}
          busy={mutations.create.isPending}
          onClose={() => setCreatingPerson(false)}
          onSubmit={(input) =>
            mutations.create.mutate(input, {
              onSuccess: (newId) => {
                setPersonId(newId);
                setCreatingPerson(false);
              },
            })
          }
        />
      )}
    </>
  );
}

