import { Text } from "@mantine/core";
import { refOf } from "../utils/entityLinks";
import EntityLink from "./EntityLink";

/**
 * The login that saved, took or linked something (a table's "by" cell): its person's page while the login has an active person (`personId`; the name is that person's),
 * plain text when it has none, "—" (dimmed) when the login is gone. A login's edit page is the ADMIN's and is not offered here (the person is the one to read).
 */
export default function CreatorName({ creator }: { creator: { name: string; personId: number | null } | null | undefined }) {
  if (creator == null) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return <EntityLink entity={refOf("person", creator.personId)} name={creator.name} size="sm" />;
}
