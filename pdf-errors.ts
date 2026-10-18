/** Processing-policy rejections must not enter an extraction fallback route. */
export class PDFProcessingLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PDFProcessingLimitError";
	}
}
