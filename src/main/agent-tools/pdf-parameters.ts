import { Type } from "typebox";

export const pdfParameters = {
  path: Type.String({ minLength: 1, description: "Workspace-relative PDF path" }),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
};

export const pdfPagesParameters = Type.Object({
  path: pdfParameters.path,
  pages: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 1,
    description: "1-based page numbers, returned in the requested order",
  }),
  timeout_seconds: pdfParameters.timeout_seconds,
}, { additionalProperties: false });
