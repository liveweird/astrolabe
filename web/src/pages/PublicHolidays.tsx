import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionIcon, Button, Group, Paper, Select, Stack, Table, Text, TextInput, VisuallyHidden } from "@mantine/core";
import { IconCalendarOff, IconCalendarPlus, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { applyHolidayPreset, createPublicHoliday, deletePublicHoliday, listPublicHolidays, type PublicHoliday } from "../api/calendar";
import { ApiError } from "../api/http";
import { useAdmin } from "../auth";
import ConfirmActionModal from "../components/ConfirmActionModal";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import ScrollRegion from "../components/ScrollRegion";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { HOLIDAYS_QUERY_KEY } from "../hooks/useHolidays";
import { isValidIsoDate } from "../utils/isoDate";
import { CONTENT_MAX_WIDTH } from "../utils/layout";
import { holidaysOfYear, holidayYears, localYear, weekdayName, yearOf } from "../utils/publicHolidays";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";

const MAX_NAME = 100;

/** What the last preset call did, kept under the year picker until the viewer moves on. */
type PresetResult = { year: string; added: number; skipped: number };

/**
 * The global public-holiday dictionary (`/public-holidays`, Flow's page ported): every signed-in user reads it, only an ADMIN adds or
 * deletes (the strip above the table, the row's delete button) or applies the Polish preset for the year being viewed. A holiday is a
 * day nobody works, in every team's calendar: the timelines hatch it and the server's views leave it out of every working-day figure,
 * so a write refreshes the dictionary AND the plan views (`["calendar"]`, `["plan"]`, `["roadmap"]`; the server bumps the plan revision).
 * The dictionary spans many years, so the table shows ONE year at a time (client-side: the endpoint is unpaged), defaulting to the
 * current one.
 */
export default function PublicHolidays() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const admin = useAdmin();
  const [currentYear] = useState(localYear);
  const [year, setYear] = useState(currentYear);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetting, setPresetting] = useState(false);
  const [presetResult, setPresetResult] = useState<PresetResult | null>(null);

  const holidays = useQuery({ queryKey: HOLIDAYS_QUERY_KEY, queryFn: listPublicHolidays });
  const refresh = () => refreshQueriesAfterMutation(queryClient, ["calendar"], ["plan"], ["roadmap"], ["flow", "deviations"]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const deleteConfirm = useDeleteConfirm<PublicHoliday>({
    mutationFn: async (row) => {
      try {
        await deletePublicHoliday(row.id);
      } catch (err) {
        // 404: someone else deleted it first. The row is stale, so reload the list (the dialog still says it is gone).
        if (err instanceof ApiError && err.status === 404) await refresh();
        throw err;
      }
    },
    onSuccess: refresh,
    successMessage: t("calendar.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  const dateInvalid = date !== "" && !isValidIsoDate(date);
  const canAdd = isValidIsoDate(date) && name.trim().length > 0 && name.trim().length <= MAX_NAME;

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!canAdd || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPublicHoliday({ date, name: name.trim() });
      await refresh();
      showSuccessToast(t("calendar.toast.added"));
      // Show where the new row landed, whatever year was open.
      setYear(yearOf(date));
      setPresetResult(null);
      setName("");
      setDate("");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t("calendar.duplicateDate")
          : saveErrorMessage(err, t, {
              forbidden: "calendar.error.forbidden",
              invalid: "calendar.invalid",
              failedStatus: "calendar.error.failedStatus",
              failed: "calendar.error.failed",
            }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function applyPreset() {
    setPresetting(true);
    setError(null);
    try {
      const result = await applyHolidayPreset({ preset: "POLISH", year: Number(year) });
      await refresh();
      showSuccessToast(t("calendar.toast.presetAdded"));
      setPresetResult({ year, added: result.added.length, skipped: result.skipped.length });
    } catch (err) {
      setError(
        saveErrorMessage(err, t, {
          forbidden: "calendar.error.forbidden",
          invalid: "calendar.error.presetInvalid",
          failedStatus: "calendar.error.presetFailedStatus",
          failed: "calendar.error.presetFailed",
        }),
      );
    } finally {
      setPresetting(false);
      setPresetOpen(false);
    }
  }

  const rows = holidays.data ? holidaysOfYear(holidays.data, year) : [];

  return (
    <Stack gap="md">
      <PageHeader titleRef={titleRef} title={t("calendar.title")} description={t(admin ? "calendar.hint" : "calendar.hintReadOnly")} />

      {admin && (
        <Paper withBorder p="md" maw={CONTENT_MAX_WIDTH}>
          <Group component="form" onSubmit={(event) => void add(event)} align="flex-end" gap="md" wrap="wrap">
            <TextInput
              label={t("calendar.date")}
              placeholder={t("common.dateFormatHint")}
              value={date}
              onChange={(e) => setDate(e.currentTarget.value.trim())}
              error={dateInvalid ? t("calendar.dateInvalid") : undefined}
              w={180}
            />
            <TextInput label={t("calendar.name")} value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={MAX_NAME} w={300} />
            <Button type="submit" leftSection={<IconPlus size={16} />} loading={submitting} disabled={!canAdd}>
              {t("calendar.addHoliday")}
            </Button>
          </Group>
        </Paper>
      )}

      {error && (
        <Stack maw={CONTENT_MAX_WIDTH}>
          <FormErrorAlert>{error}</FormErrorAlert>
        </Stack>
      )}
      {holidays.isError && <ErrorAlert error={holidays.error} />}

      {holidays.isLoading ? (
        <LoadingBlock />
      ) : holidays.data ? (
        <Stack gap="sm" maw={CONTENT_MAX_WIDTH}>
          <Group align="flex-end" gap="md" wrap="wrap">
            <Select
              label={t("calendar.year")}
              data={holidayYears(holidays.data, currentYear, year)}
              value={year}
              onChange={(value) => {
                if (value) {
                  setYear(value);
                  setPresetResult(null);
                }
              }}
              allowDeselect={false}
              w={140}
            />
            {admin && (
              <Button variant="default" leftSection={<IconCalendarPlus size={16} />} onClick={() => setPresetOpen(true)}>
                {t("calendar.preset.button", { year })}
              </Button>
            )}
          </Group>
          {presetResult && (
            <Text role="status" size="sm">
              {t("calendar.preset.result", { year: presetResult.year, added: presetResult.added, skipped: presetResult.skipped })}
            </Text>
          )}
          {rows.length > 0 ? (
            <ScrollRegion label={t("calendar.tableAria", { year })} minWidth={520}>
              <Table aria-label={t("calendar.tableAria", { year })}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("calendar.date")}</Table.Th>
                    <Table.Th>{t("calendar.weekday")}</Table.Th>
                    <Table.Th>{t("calendar.name")}</Table.Th>
                    {admin && (
                      <Table.Th style={{ width: 1 }}>
                        <VisuallyHidden>{t("common.table.operations")}</VisuallyHidden>
                      </Table.Th>
                    )}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((holiday) => (
                    <Table.Tr key={holiday.id}>
                      <Table.Td>{holiday.date}</Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" component="span">
                          {weekdayName(holiday.date, i18n.language)}
                        </Text>
                      </Table.Td>
                      <Table.Td>{holiday.name}</Table.Td>
                      {admin && (
                        <Table.Td style={{ width: 1 }} ta="right">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            size="sm"
                            aria-label={t("calendar.deleteAria", { name: holiday.name })}
                            onClick={() => deleteConfirm.requestDelete(holiday)}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollRegion>
          ) : (
            <EmptyState icon={IconCalendarOff} label={t(admin ? "calendar.empty" : "calendar.emptyReadOnly", { year })} />
          )}
        </Stack>
      ) : null}

      <ConfirmActionModal
        opened={presetOpen}
        onClose={() => setPresetOpen(false)}
        title={t("calendar.preset.title")}
        message={t("calendar.preset.body", { year })}
        cancelLabel={t("common.action.cancel")}
        confirmLabel={t("calendar.preset.confirm")}
        onConfirm={() => void applyPreset()}
        loading={presetting}
        confirmColor="astrolabe"
      />
      <ConfirmDeleteModal
        confirm={deleteConfirm}
        title={t("calendar.deleteTitle")}
        errorTitle={t("calendar.deleteFailed")}
        body={(holiday) => t("calendar.deleteBody", { date: holiday.date, name: holiday.name })}
        errorMessage={(err) =>
          saveErrorMessage(err, t, {
            forbidden: "calendar.error.forbidden",
            notFound: "calendar.error.gone",
            failedStatus: "calendar.error.deleteFailedStatus",
            failed: "calendar.error.deleteFailed",
          })
        }
      />
    </Stack>
  );
}
