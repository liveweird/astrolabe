import { VisuallyHidden } from "@mantine/core";
import { IconPin } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/**
 * The glyph of a milestone whose dates are pinned (1.7): a small pin after the name, decorative, with the fact in hidden text so it is read
 * ("pinned"). A pinned milestone is fixed in the auto-proposal; nothing else about the row changes.
 */
export default function PinMark() {
  const { t } = useTranslation();
  return (
    <>
      {" "}
      <IconPin size={12} aria-hidden style={{ verticalAlign: "-1px" }} />
      <VisuallyHidden>{t("timeline.pinned")}</VisuallyHidden>
    </>
  );
}
