import { Type } from "@sinclair/typebox";

/** Schema TypeBox para el endpoint de creación de tickets de soporte. */

export const CreateSupportTicketBody = Type.Object({
	type: Type.String({ description: "Tipo de ticket: complaint | suggestion | security | data" }),
	title: Type.String({ description: "Título (5-200 caracteres)" }),
	email: Type.String({ description: "Email de contacto (validado en servidor)" }),
	description: Type.String({ description: "Descripción detallada (10-5000 caracteres)" }),
	// Campos opcionales de bug bounty (solo relevantes para type === "security")
	wantsCredit: Type.Optional(Type.Boolean({ description: "Aceptar agradecimiento público (bug bounty)" })),
	creditName: Type.Optional(Type.String({ description: "Handle/nombre para los agradecimientos públicos (máx 80)" })),
	rewardPreference: Type.Optional(
		Type.Union([Type.Literal("plus"), Type.Literal("pro")], { description: "Preferencia de recompensa del reporter" })
	),
});
