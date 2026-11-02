/** The ONE place the baselines route family is spelled out — never hand-assemble a baseline URL. */
export const baselinesPath = "/baselines";
/** A baseline's comparison page (`/baselines/:id`). */
export const baselinePath = (id: number) => `${baselinesPath}/${id}`;
