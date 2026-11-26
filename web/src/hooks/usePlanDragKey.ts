import { createContext, useContext } from "react";

/** The key of the row being dragged (`ws:<id>` / `pg:<id>`), or `null`: the row draws half transparent while it is held (the row itself never moves). */
export const PlanDragContext = createContext<string | null>(null);

export const usePlanDragKey = (): string | null => useContext(PlanDragContext);
