import { useEffect, useRef } from "react";
import type { ProposalFlow } from "../utils/scheduleProposal";

/** What the focus hand-over reads of a proposal hook (structural: the team page's and the cross-team page's both fit). */
type Proposal = Pick<ProposalFlow, "rescoped"> & { applying: boolean };

/**
 * Focus follows the schedule proposal's preview on the team page and the cross-team page: Discard (in the section) takes it when a proposal opens, Propose gets it back once
 * the preview is closed (discarded, accepted or voided by a stale refusal) and no write is running any more (`busy`), since a button that is still
 * disabled cannot take it. Returns the two refs the page hands to the buttons.
 */
export function useProposalFocus(proposal: Proposal, open: object | null, busy: boolean) {
  const proposeRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const isOpen = open !== null;
  // Discard takes the focus when a preview opens, but only once the accept is no longer running (a disabled button cannot take it): a
  // preview that opens while `applying` (a fresh proposal after a stale-scope refusal) waits for it. A failed accept never re-arms this,
  // so its inline alert keeps the focus it was given.
  const focusDiscard = useRef(false);
  const applying = proposal.applying;
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      focusDiscard.current = true;
    }
  }, [isOpen]);
  // The fresh preview of a stale-scope refusal may replace the voided one within one render batch (`isOpen` stays true): its note
  // appearing arms the hand-over as well.
  const rescoped = proposal.rescoped;
  useEffect(() => {
    if (rescoped) focusDiscard.current = true;
  }, [rescoped]);
  useEffect(() => {
    if (isOpen && !applying && focusDiscard.current) {
      focusDiscard.current = false;
      discardRef.current?.focus();
    }
  }, [isOpen, applying, rescoped]);
  useEffect(() => {
    if (!isOpen && wasOpen.current && !busy) {
      wasOpen.current = false;
      proposeRef.current?.focus();
    }
  }, [isOpen, busy]);
  return { proposeRef, discardRef };
}
