import type { Block } from "@common/ADC/types/learning.ts";

export const REDACTED_VALUE = "(cuenta eliminada)";

/**
 * Redacta los párrafos que empiezan con alguna de las etiquetas dadas, conservando la etiqueta.
 *
 * El cuerpo de los tickets es texto libre: la única forma de encontrar los datos personales que
 * pusimos nosotros es por el prefijo con el que los escribimos. Por eso las etiquetas se generan
 * y se buscan desde la misma constante — si cambia una, los tickets viejos dejan de redactarse.
 */
export function redactLabeledParagraphs(blocks: Block[], labels: Readonly<Record<string, string>>): Block[] {
	const prefixes = Object.values(labels).map((label) => `${label}: `);
	return blocks.map((block) => {
		if (block.type !== "paragraph") return block;
		const prefix = prefixes.find((p) => block.text.startsWith(p));
		return prefix ? { ...block, text: `${prefix}${REDACTED_VALUE}` } : block;
	});
}
