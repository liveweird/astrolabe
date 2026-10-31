/** The ONE place the people route family is spelled out — never hand-assemble a person URL. */
export const peoplePath = "/people";
export const personPath = (id: number) => `${peoplePath}/${id}`;
