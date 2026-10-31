import { Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconListNumbers } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import RoadmapRankedTable from "../components/RoadmapRankedTable";
import RoadmapUnrankedTable from "../components/RoadmapUnrankedTable";
import { useRoadmapRanking } from "../hooks/useRoadmapRanking";

/**
 * The Roadmap page (`/roadmap`): the ONE global project ranking, readable by everyone — the ranked list (rank, project,
 * program, work stream, owner, target window) and an "Unranked" group below it. Whether the lists are editable comes from the
 * view's `can.editRank` (the server's own arithmetic), never from the session's roles. Every change is saved at once as the
 * wholesale ranking PUT (`hooks/useRoadmapRanking.ts`).
 */
export default function Roadmap() {
  const { t } = useTranslation();
  const ranking = useRoadmapRanking();
  const { view, query } = ranking;
  const editable = view?.can.editRank ?? false;
  const empty = view !== undefined && view.ranked.length === 0 && view.unranked.length === 0;

  return (
    <Stack gap="md">
      <PageHeader title={t("roadmap.title")} description={editable ? t("roadmap.introEdit") : t("roadmap.intro")} />

      {query.isError && <ErrorAlert error={query.error} title={t("roadmap.loadFailed")} />}
      {ranking.stale && <FormErrorAlert>{t("roadmap.stale")}</FormErrorAlert>}
      {ranking.error && <FormErrorAlert>{ranking.error}</FormErrorAlert>}
      {/* Button-driven changes are announced here (a drag is announced by dnd-kit's own live region). */}
      <VisuallyHidden role="status" aria-live="polite">
        {ranking.announcement}
      </VisuallyHidden>

      {query.isLoading && <LoadingBlock />}
      {empty && <EmptyState icon={IconListNumbers} label={t("roadmap.empty")} hint={t("roadmap.emptyHint")} />}
      {view && !empty && (
        <>
          <Stack gap="xs">
            <Title order={3} size="h4">
              {t("roadmap.rankedTitle")}
            </Title>
            {view.ranked.length === 0 ? (
              <Text size="sm" c="dimmed">
                {editable ? t("roadmap.noRankedEdit") : t("roadmap.noRanked")}
              </Text>
            ) : (
              <RoadmapRankedTable
                rows={view.ranked}
                label={t("roadmap.rankedTableAria")}
                editing={editable ? { move: ranking.move, unrank: ranking.unrank, dropOver: ranking.dropOver, busy: ranking.pending } : null}
              />
            )}
          </Stack>
          <Stack gap="xs">
            <Title order={3} size="h4">
              {t("roadmap.unrankedTitle")}
            </Title>
            {view.unranked.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("roadmap.noUnranked")}
              </Text>
            ) : (
              <RoadmapUnrankedTable rows={view.unranked} label={t("roadmap.unrankedTableAria")} onRank={editable ? ranking.rank : null} />
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}
