import type { CSSProperties } from "react";
import classes from "../theme.module.css";
import { teamColourVar, type TeamColour } from "../utils/teamColours";

/**
 * A team's colour mark: a small square beside the team's name. Decorative (`aria-hidden`, the name beside it is the information) and
 * never a carrier of text; `data-team-colour` is what tests read (never the colour itself). Without a colour yet (the teams read has not answered)
 * it keeps its box as an invisible, unmarked placeholder, so the name does not shift when the colour arrives.
 */
export default function TeamSwatch({ colour, size }: { colour: TeamColour | undefined; size?: number }) {
  const style: CSSProperties = {
    ...(colour === undefined ? {} : { backgroundColor: teamColourVar(colour) }),
    ...(size === undefined ? {} : { width: size, height: size }),
  };
  return colour === undefined ? (
    <span aria-hidden="true" className={`${classes.teamSwatch} ${classes.teamSwatchPending}`} style={style} />
  ) : (
    <span aria-hidden="true" data-team-colour={colour} className={classes.teamSwatch} style={style} />
  );
}
