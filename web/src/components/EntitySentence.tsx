import { Fragment, type ReactNode } from "react";

/** Private-use characters: they open and close a slot's mark in the translated sentence and appear in no translation. */
const OPEN = "";
const CLOSE = "";
const MARKED = new RegExp(`${OPEN}(\\w+)${CLOSE}`);

/**
 * A translated sentence with entity links inside it (1.31): the sentence is translated once, with a mark in place of each name, and the marks are replaced by the
 * links - so the words around a name stay in the translator's order (EN and PL differ) and no name passes through `<Trans>`. `text` receives one mark per slot key
 * and returns the sentence (`(m) => t("deviations.ack.done", { name: m.by, date })`); `slots` holds what takes each mark's place (an `EntityLink`, or plain text).
 */
export default function EntitySentence({ text, slots }: { text: (marks: Record<string, string>) => string; slots: Record<string, ReactNode> }) {
  const marks = Object.fromEntries(Object.keys(slots).map((key) => [key, `${OPEN}${key}${CLOSE}`]));
  // split() with one capture group alternates text and slot keys: even indexes are the sentence's words, odd ones the key of a slot.
  const parts = text(marks).split(MARKED);
  return (
    <>
      {parts.map((part, index) => (
        // The parts of one sentence never reorder, so the index is a stable key.
        <Fragment key={index}>{index % 2 === 0 ? part : slots[part]}</Fragment>
      ))}
    </>
  );
}
