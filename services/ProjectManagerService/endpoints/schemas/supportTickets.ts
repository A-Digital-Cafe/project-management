import { Type } from "@sinclair/typebox";

/** Schema TypeBox para el endpoint de creación de tickets de soporte. */

export const CreateSupportTicketBody = Type.Object({
	type: Type.String({ description: "Tipo de ticket: complaint | suggestion | security" }),
	title: Type.String({ description: "Título (5-200 caracteres)" }),
	email: Type.String({ description: "Email de contacto (validado en servidor)" }),
	description: Type.String({ description: "Descripción detallada (10-5000 caracteres)" }),
});
