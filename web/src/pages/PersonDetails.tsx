import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Button, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPencil } from "@tabler/icons-react";
import { ApiError } from "../api/http";
import { useAdmin } from "../auth";
import { getPerson } from "../api/people";
import EditPageLoadState from "../components/EditPageLoadState";
import PageHeader from "../components/PageHeader";
import PersonEditorModal from "../components/PersonEditorModal";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { peoplePath } from "../utils/peopleLinks";
import { loadErrorMessage } from "../utils/saveError";

/**
 * One person (`/people/:id`): their name, email and login. Everyone reads it; an ADMIN edits the person.
 */
export default function PersonDetails() {
  const { t } = useTranslation();
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const queryClient = useQueryClient();
  const admin = useAdmin();

  const person = useQuery({ queryKey: ["people", "detail", id], queryFn: () => getPerson(id), enabled: Number.isFinite(id) });
  const [editing, setEditing] = useState(false);
  useDialogFocus(editing);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["people"] });
  }

  if (person.isLoading || person.isError || !person.data) {
    const notFound = person.error instanceof ApiError && person.error.status === 404;
    return (
      <EditPageLoadState
        isLoading={person.isLoading}
        message={notFound ? t("people.notFound") : loadErrorMessage(person.error, t)}
        backTo={peoplePath}
        backLabel={t("people.backToPeople")}
        title={t("people.title")}
      />
    );
  }
  const data = person.data;

  return (
    <Stack gap="md">
      <PageHeader
        title={data.name}
        description={
          <>
            <Text span display="block">
              {data.email ? t("people.emailLine", { email: data.email }) : t("people.noEmail")}
            </Text>
            <Text span display="block">
              {data.userEmail ? t("people.loginLine", { email: data.userEmail }) : t("people.noLogin")}
            </Text>
          </>
        }
        backTo={{ to: peoplePath, label: t("people.backToPeople") }}
        actions={
          admin && (
            <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
              {t("common.action.edit")}
            </Button>
          )
        }
      />

      {editing && (
        <PersonEditorModal
          target={data}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      )}
    </Stack>
  );
}
