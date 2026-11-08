import { Badge } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** Marks a Jira connection served by the development Jira stub, not Atlassian (derived by the server per response, never stored). */
export default function JiraStubBadge() {
  const { t } = useTranslation();
  return (
    <Badge color="gray" variant="light" tt="none" title={t("jira.stub.title")}>
      {t("jira.stub.badge")}
    </Badge>
  );
}
