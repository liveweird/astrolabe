import { useEffect, useId, useRef } from "react";
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isBoolean, useStoredState } from "../hooks/useStoredState";
import { usePlanDependencies } from "../hooks/usePlanDependencies";
import { namesPanel, PANEL_PARAMS, parseDependencyListFilter, withoutPanelWord, withPanelFilter, type DependencyListFilter } from "../utils/dependencyListFilters";
import { ANCHORED_HEADING_STYLE } from "../utils/layout";
import PlanDependenciesContent from "./PlanDependenciesContent";
import TableDisclosure from "./TableDisclosure";

/** The view-settings key of the show/hide choice (`astrolabe.viewSettings.roadmap.dependenciesOpen`), one for the Roadmap and the Programs page. */
const OPEN_KEY = "roadmap.dependenciesOpen";

/**
 * The plan's dependency list under the Roadmap's and the Programs page's timeline (1.29): the explicit text of the arrows, every dependency of the plan
 * (not only the links between projects) with the Dependencies page's filters, row menu, "Add dependency" and delete, all by the rows' own `can` flags.
 * Hidden by default and remembered per browser; a hidden panel is not rendered (so it does not print, heading included) and is not READ either (`enabled`). The address
 * names it too (`dependencies=all|violated|ok|unscheduled`, `dependencyTeamId`, `dependencyProjectId`): such a link OPENS it for that visit without
 * writing the memory and moves the focus to the heading once. The panel never writes the address on its own; a filter change writes it (`replace`),
 * and hiding a panel the address opened takes the word away, or it would stay open.
 */
export default function PlanDependenciesPanel() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const named = namesPanel(params);
  const filter = parseDependencyListFilter(params, PANEL_PARAMS);
  const [remembered, setRemembered] = useStoredState(OPEN_KEY, false, isBoolean);
  const open = remembered || named;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const state = usePlanDependencies({ filter, enabled: open, focusAfterDelete: headingRef });
  // A link that names the panel brings the user to it: the focus (and with it the scroll) goes to the heading when the panel arrives, once.
  const arrivedByAddress = useRef(named);
  useEffect(() => {
    if (arrivedByAddress.current) headingRef.current?.focus();
  }, []);

  const toggle = (next: boolean) => {
    setRemembered(next);
    if (!next && named) setParams((previous) => withoutPanelWord(previous), { replace: true });
  };
  const change = (patch: Partial<DependencyListFilter>) => setParams((previous) => withPanelFilter(previous, { ...filter, ...patch }), { replace: true });

  return (
    // A named region: the page has other "Filters" toggles (the Roadmap's, the Programs page's), and this one says which list it narrows.
    <Stack component="section" aria-labelledby={headingId} gap="xs">
      <Group gap="sm" align="center" justify="space-between">
        <Title id={headingId} order={3} size="h4" ref={headingRef} tabIndex={-1} style={ANCHORED_HEADING_STYLE} data-print={open ? undefined : "hide"}>
          {t("dependencyList.panel.title")}
        </Title>
        {open && state.canAdd && (
          <Button variant="default" size="compact-md" data-print="hide" leftSection={<IconPlus size={16} />} onClick={() => state.setAdding(true)}>
            {t("project.dependency.add")}
          </Button>
        )}
      </Group>
      <TableDisclosure open={open} onOpenChange={toggle} showLabel={t("dependencyList.panel.show")} hideLabel={t("dependencyList.panel.hide")}>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t("dependencyList.panel.intro")}
          </Text>
          <PlanDependenciesContent state={state} filter={filter} onChange={change} onClear={() => setParams((previous) => withPanelFilter(previous, {}), { replace: true })} />
        </Stack>
      </TableDisclosure>
    </Stack>
  );
}
