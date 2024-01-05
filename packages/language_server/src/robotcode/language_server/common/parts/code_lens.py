from concurrent.futures import CancelledError
from typing import TYPE_CHECKING, Any, Final, List, Optional

from robotcode.core.concurrent import Task, check_current_task_canceled, run_as_task
from robotcode.core.event import event
from robotcode.core.lsp.types import (
    CodeLens,
    CodeLensOptions,
    CodeLensParams,
    ServerCapabilities,
    TextDocumentIdentifier,
)
from robotcode.core.utils.logging import LoggingDescriptor
from robotcode.jsonrpc2.protocol import rpc_method
from robotcode.language_server.common.decorators import language_id_filter
from robotcode.language_server.common.text_document import TextDocument

from .protocol_part import LanguageServerProtocolPart

if TYPE_CHECKING:
    from robotcode.language_server.common.protocol import LanguageServerProtocol


class CodeLensProtocolPart(LanguageServerProtocolPart):
    _logger: Final = LoggingDescriptor()

    def __init__(self, parent: "LanguageServerProtocol") -> None:
        super().__init__(parent)
        self.refresh_task: Optional[Task[Any]] = None
        self._refresh_timeout = 5

    @event
    def collect(sender, document: TextDocument) -> Optional[List[CodeLens]]:
        ...

    @event
    def resolve(sender, code_lens: CodeLens) -> Optional[CodeLens]:
        ...

    def extend_capabilities(self, capabilities: ServerCapabilities) -> None:
        if len(self.collect):
            capabilities.code_lens_provider = CodeLensOptions(resolve_provider=True if len(self.resolve) > 0 else None)

    @rpc_method(name="textDocument/codeLens", param_type=CodeLensParams, threaded=True)
    def _text_document_code_lens(
        self, text_document: TextDocumentIdentifier, *args: Any, **kwargs: Any
    ) -> Optional[List[CodeLens]]:
        results: List[CodeLens] = []
        document = self.parent.documents.get(text_document.uri)
        if document is None:
            return None

        for result in self.collect(self, document, callback_filter=language_id_filter(document)):
            check_current_task_canceled()

            if isinstance(result, BaseException):
                if not isinstance(result, CancelledError):
                    self._logger.exception(result, exc_info=result)
            else:
                if result is not None:
                    results.extend(result)

        if not results:
            return None

        for r in results:
            r.range = document.range_to_utf16(r.range)

        return results

    @rpc_method(name="codeLens/resolve", param_type=CodeLens, threaded=True)
    def _code_lens_resolve(self, params: CodeLens, *args: Any, **kwargs: Any) -> CodeLens:
        results: List[CodeLens] = []

        for result in self.resolve(self, params):
            check_current_task_canceled()

            if isinstance(result, BaseException):
                if not isinstance(result, CancelledError):
                    self._logger.exception(result, exc_info=result)
            else:
                if result is not None:
                    results.append(result)

        if len(results) > 1:
            self._logger.warning("More then one resolve result collected.")
            return results[-1]

        return params

    def refresh(self, now: bool = True) -> None:
        if self.refresh_task is not None and not self.refresh_task.done():
            self.refresh_task.cancel()

        self.refresh_task = run_as_task(self._refresh, now)

    def _refresh(self, now: bool = True) -> None:
        if (
            self.parent.client_capabilities is not None
            and self.parent.client_capabilities.workspace is not None
            and self.parent.client_capabilities.workspace.code_lens is not None
            and self.parent.client_capabilities.workspace.code_lens.refresh_support
        ):
            if not now:
                check_current_task_canceled(1)

            self.parent.send_request("workspace/codeLens/refresh").result(self._refresh_timeout)
