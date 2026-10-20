# Web Access

Web search and content extraction for documents and web resources.

## Language

**Web-page provider**:
An extraction service or engine that retrieves readable content from a web page, distinct from specialized PDF, repository, or video extraction.
_Avoid_: Search provider when referring to web-page extraction

**Explicit provider selection**:
A request to use only the named provider when ordinary web-page extraction applies, without substitution by another web-page provider. Specialized extraction is a separate resource-specific route.
_Avoid_: Preferred provider when no fallback is permitted

**Specialized extractor**:
A service or engine that interprets a particular resource type, such as a PDF, repository, or video, rather than extracting an ordinary web page.
_Avoid_: Web-page provider when referring to specialized extraction

**Specialized dispatch**:
Resource-specific selection of an applicable, enabled specialized extractor before ordinary web-page routing. Selecting a web-page provider does not itself disable specialized dispatch.
_Avoid_: Provider fallback when referring to initial resource-specific selection

**Provider attempt**:
An actual invocation of an extraction route, distinct from a configured route that was skipped or blocked before invocation.
_Avoid_: Attempt when referring only to a configured or selected provider

**Extraction provenance**:
The web-page provider, any specialized extractor, and the ordered attempts responsible for an extraction result. It describes source extraction rather than subsequent answer generation.
_Avoid_: Selected provider when referring to the route that actually produced content

**Local PDF source**:
A PDF document available as a file on the machine running Web Access, rather than retrieved from a web address. Its location does not determine which PDF provider processes it.
_Avoid_: Local extraction when referring only to the source location

**PDF provider**:
An extraction service or engine that converts a PDF document into readable document content.
_Avoid_: Search provider when referring to PDF extraction

**PaddleOCR provider**:
A PDF provider backed by Baidu AI Studio's hosted PaddleOCR document-parsing service.
_Avoid_: Self-hosted PaddleOCR when referring to this integration

**PDF page limit**:
The maximum number of document pages permitted to undergo extraction, not merely a cap on the pages shown in the returned content.
_Avoid_: Output limit when referring to processing limits
