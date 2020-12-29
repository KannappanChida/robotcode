from asyncio import AbstractEventLoop
from typing import Optional, Type

from ..jsonrpc2 import TCP_DEFAULT_PORT, JsonRPCProtocol, JsonRPCServer, JsonRpcServerMode, StdIoParams, TcpParams
from .protocol import LanguageServerProtocol

__all__ = ["LanguageServer"]


class LanguageServer(JsonRPCServer):
    def __init__(
        self,
        mode: JsonRpcServerMode = JsonRpcServerMode.STDIO,
        stdio_params: StdIoParams = StdIoParams(None, None),
        tcp_params: TcpParams = TcpParams(None, TCP_DEFAULT_PORT),
        protocol_cls: Type[JsonRPCProtocol] = LanguageServerProtocol,
        loop: Optional[AbstractEventLoop] = None,
    ):
        super().__init__(
            mode=mode,
            stdio_params=stdio_params,
            tcp_params=tcp_params,
            protocol_cls=protocol_cls,
            loop=loop,
        )
