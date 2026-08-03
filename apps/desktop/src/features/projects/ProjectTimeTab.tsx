import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock3, Plus } from "lucide-react";
import { laborCostMinor, minutesToHours } from "@mep/core";
import { useTimeEntriesByProject, useTimeEntryMutations, type TimeEntryListItem } from "../../repositories/timeEntries";
import { DataTable, type Column } from "../../components/DataTable";
import { Button, Card, EmptyState, SectionHeader } from "../../components/ui";
import { useFormat } from "../../lib/format";
import { TimeEntryForm } from "../time/TimePage";

export function ProjectTime({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: entries = [] } = useTimeEntriesByProject(projectId);
  const mutations = useTimeEntryMutations();
  const [logging, setLogging] = useState(false);
  const totalMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);

  const columns: Column<TimeEntryListItem>[] = [
    {
      key: "date",
      header: t("common.date"),
      value: (entry) => entry.date,
      render: (entry) => fmt.date(entry.date),
    },
    {
      key: "person",
      header: t("time.person"),
      value: (entry) => entry.personName,
    },
    {
      key: "stage",
      header: t("time.stage"),
      value: (entry) => entry.stageName,
      render: (entry) => entry.stageName ?? "—",
    },
    {
      key: "notes",
      header: t("common.notes"),
      value: (entry) => entry.note,
    },
    {
      key: "hours",
      header: t("time.hours"),
      value: (entry) => entry.minutes,
      render: (entry) =>
        `${minutesToHours(entry.minutes)}${t("time.hoursShort")}`,
      align: "end",
    },
    {
      key: "cost",
      header: t("time.laborCost"),
      value: (entry) =>
        entry.hourlyRateMinor
          ? laborCostMinor(entry.minutes, entry.hourlyRateMinor)
          : 0,
      render: (entry) =>
        entry.hourlyRateMinor
          ? fmt.money(
              laborCostMinor(entry.minutes, entry.hourlyRateMinor),
              entry.personCurrency,
            )
          : "—",
      align: "end",
    },
  ];

  return (
    <section>
      <SectionHeader
        title={t("time.title")}
        description={`${t("time.totalHours")}: ${minutesToHours(totalMinutes)}${t("time.hoursShort")}`}
        actions={
          <Button variant="primary" onClick={() => setLogging(true)}>
            <Plus size={15} aria-hidden="true" />
            {t("time.newEntry")}
          </Button>
        }
      />
      {entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={Clock3}
            title={t("projects.emptyTime")}
            description={t("projects.emptyTimeHint")}
            action={
              <Button variant="primary" onClick={() => setLogging(true)}>
                <Plus size={15} aria-hidden="true" />
                {t("time.newEntry")}
              </Button>
            }
          />
        </Card>
      ) : (
        <DataTable
          rows={entries}
          columns={columns}
          rowKey={(entry) => entry.id}
          density="compact"
          initialSort={{ key: "date", dir: "desc" }}
        />
      )}

      {logging && (
        <TimeEntryForm
          initial={null}
          lockProjectId={projectId}
          busy={mutations.create.isPending}
          onClose={() => setLogging(false)}
          onSubmit={(input) =>
            mutations.create.mutate(input, {
              onSuccess: () => setLogging(false),
            })
          }
        />
      )}
    </section>
  );
}
