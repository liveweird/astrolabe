import { CheckIcon, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ProjectPickerItem } from "../utils/projectPicker";

/**
 * One line of the project picker's dropdown (`renderOption`, which drops Mantine's own check mark, so it is drawn here): the project's name and, when
 * a milestone of it matched the search, a dimmed "Milestone: X" line (the first found, "+N more" for the rest). The notice line (the milestone search
 * failed or was cut) is one dimmed sentence.
 */
export default function ProjectPickerOption({ option, checked }: { option: ProjectPickerItem; checked?: boolean }) {
  const { t } = useTranslation();
  if (option.notice) {
    return (
      <Text size="xs" c="dimmed">
        {option.label}
      </Text>
    );
  }
  const [first, ...others] = option.milestones ?? [];
  return (
    <>
      {checked && <CheckIcon aria-hidden size={12} style={{ flexShrink: 0, marginInlineEnd: "var(--mantine-spacing-xs)", opacity: 0.6 }} />}
      <Stack gap={0}>
        <span>{option.label}</span>
        {first !== undefined && (
          <Text size="xs" c="dimmed">
            {others.length === 0 ? t("project.picker.milestone", { name: first }) : t("project.picker.milestoneMore", { name: first, more: others.length })}
          </Text>
        )}
      </Stack>
    </>
  );
}
