import { Type } from "@sinclair/typebox";

/** Schema TypeBox para el endpoint de solicitud de creación de organización. */

export const CreateOrgRequestBody = Type.Object({
	name: Type.String({ description: "Nombre de la organización (3-120 caracteres)" }),
	email: Type.String({ description: "Email de contacto (validado en servidor)" }),
	description: Type.Optional(Type.String({ description: "Descripción (máx. 2000 caracteres)" })),
	url: Type.Optional(Type.String({ description: "URL (http/https)" })),
	socialNetworks: Type.Optional(
		Type.Array(Type.Object({ platform: Type.String(), url: Type.String() }), { description: "Máx. 10 redes sociales" })
	),
});
