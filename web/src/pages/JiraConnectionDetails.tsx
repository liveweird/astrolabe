import { getJiraConnection } from "../api/jira";
import ConnectionDetailsPage from "../components/ConnectionDetailsPage";
import JiraBindingsSection from "../components/JiraBindingsSection";
import JiraConnectionEditorModal from "../components/JiraConnectionEditorModal";
import JiraConnectionSection from "../components/JiraConnectionSection";
import JiraCoverageSection from "../components/JiraCoverageSection";
import JiraMappingSection from "../components/JiraMappingSection";
import { jiraConnectionsPath } from "../utils/jiraLinks";

/**
 * One Jira connection (`/integrations/jira/:id`, ADMIN only): the Connection section (facts, Test connection, Refresh now, the runs) and the
 * Mapping section (discovery report, the field mapping, Peek), the Coverage section (1.14: counts per mapped level) and the Bindings section (the plan items linked through it, Unlink, "Link a node…").
 * The shell (route id, load triage, header, editor) is `ConnectionDetailsPage`.
 */
export default function JiraConnectionDetails() {
  return (
    <ConnectionDetailsPage
      kind="jira"
      connectionsPath={jiraConnectionsPath}
      fetchConnection={getJiraConnection}
      sections={(connection, readAt) => (
        <>
          <JiraConnectionSection connection={connection} readAt={readAt} />
          <JiraMappingSection connection={connection} />
          <JiraCoverageSection connection={connection} />
          <JiraBindingsSection connection={connection} />
        </>
      )}
      Editor={JiraConnectionEditorModal}
    />
  );
}
