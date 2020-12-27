import json
from robotcode.server.types import MessageActionItem
from typing import List, Optional, cast

import pytest
import asyncio


from robotcode.server.jsonrpc2_server import (
    JsonRPCError,
    JsonRPCErrorObject,
    JsonRPCErrors,
    JsonRPCMessage,
    JsonRPCProtocol,
    JsonRPCRequest,
    JsonRPCResponse,
    JsonRPCServer,
)


class DummyJsonRPCProtocol(JsonRPCProtocol):
    def __init__(self, server: Optional[JsonRPCServer]):
        super().__init__(server)
        self.handled_messages: List[JsonRPCMessage] = []
        self.sended_message: Optional[JsonRPCMessage] = None

    async def handle_message(self, message: JsonRPCMessage):
        self.handled_messages.append(message)
        return await super().handle_message(message)

    def send_data(self, message: JsonRPCMessage):
        self.sended_message = message

    async def data_received_async(self, data: bytes):
        self.data_received(data)
        return await asyncio.sleep(0)


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.mark.asyncio
async def test_receive_a_request_message_should_work():
    protocol = DummyJsonRPCProtocol(None)

    message = JsonRPCRequest(id=1, method="doSomething", params={})

    json_message = message.json().encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message

    await protocol.data_received_async(data)

    assert protocol.handled_messages == [message]


@pytest.mark.asyncio
async def test_receive_a_batch_request_should_work():
    protocol = DummyJsonRPCProtocol(None)

    message = [
        JsonRPCRequest(id=1, method="doSomething", params={}).dict(),
        JsonRPCRequest(id=2, method="doSomething", params={}).dict(),
        JsonRPCRequest(id=3, method="doSomething", params={}).dict(),
    ]

    json_message = json.dumps(message).encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message

    await protocol.data_received_async(data)

    assert protocol.handled_messages == message


@pytest.mark.asyncio
async def test_receive_invalid_jsonmessage_should_throw_send_an_error():
    protocol = DummyJsonRPCProtocol(None)

    json_message = b"{"
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message

    await protocol.data_received_async(data)
    assert (
        isinstance(protocol.sended_message, JsonRPCError)
        and cast(JsonRPCError, protocol.sended_message).error.code == JsonRPCErrors.PARSE_ERROR
    )


@pytest.mark.asyncio
async def test_receive_a_request_with_invalid_protocol_version_should_send_an_error():
    protocol = DummyJsonRPCProtocol(None)

    message = JsonRPCRequest(id=1, method="doSomething", params={})
    message.jsonrpc = "1.0"

    json_message = message.json().encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message
    await protocol.data_received_async(data)
    assert (
        isinstance(protocol.sended_message, JsonRPCError)
        and cast(JsonRPCError, protocol.sended_message).error.code == JsonRPCErrors.PARSE_ERROR
    )


@pytest.mark.asyncio
async def test_receive_an_error_should_work():
    protocol = DummyJsonRPCProtocol(None)

    message = JsonRPCError(id=1, result=None, error=JsonRPCErrorObject(code=1, message="test", data="this is the data"))

    json_message = message.json().encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message
    await protocol.data_received_async(data)
    assert protocol.handled_messages == [message]


@pytest.mark.asyncio
async def test_receive_response_should_work():
    protocol = DummyJsonRPCProtocol(None)

    r = protocol.send_request("dummy/method", ["dummy", "data"], list)

    msg = JsonRPCResponse(id=cast(JsonRPCRequest, protocol.sended_message).id, result=["dummy", "data"])
    json_message = msg.json().encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message
    await protocol.data_received_async(data)

    a = await asyncio.wait_for(r, 10)

    assert a == ["dummy", "data"]


@pytest.mark.asyncio
async def test_receive_invalid_id_in_response_should_send_an_error():
    protocol = DummyJsonRPCProtocol(None)

    message = JsonRPCResponse(id=1, result=["dummy", "data"])

    json_message = message.json().encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message
    await protocol.data_received_async(data)
    assert protocol.handled_messages == [message]
    assert isinstance(protocol.sended_message, JsonRPCError)


@pytest.mark.asyncio
async def test_receive_response_should_work_with_pydantic_model():
    protocol = DummyJsonRPCProtocol(None)

    r = protocol.send_request("dummy/method", ["dummy", "data"], MessageActionItem)

    msg = JsonRPCResponse(
        id=cast(JsonRPCRequest, protocol.sended_message).id, result=MessageActionItem(title="hi there")
    )
    json_message = msg.json().encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message
    await protocol.data_received_async(data)

    a = await asyncio.wait_for(r, 10)

    assert a == MessageActionItem(title="hi there")


@pytest.mark.asyncio
async def test_receive_response_should_work_with_pydantic_model_in_list():
    protocol = DummyJsonRPCProtocol(None)

    r = protocol.send_request("dummy/method", ["dummy", "data"], List[MessageActionItem])

    msg = JsonRPCResponse(
        id=cast(JsonRPCRequest, protocol.sended_message).id, result=[MessageActionItem(title="hi there")]
    )
    json_message = msg.json().encode("utf-8")
    header = f"Content-Length: {len(json_message)}\r\n\r\n".encode("ascii")
    data = header + json_message
    await protocol.data_received_async(data)

    a = await asyncio.wait_for(r, 10)

    assert a == [MessageActionItem(title="hi there")]
