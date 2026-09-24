import json

import httpx
import pytest
import respx

from bee2bee.protocol import GenerationRequest
from bee2bee.services import EchoService, OllamaService, ServiceError, create_service


def _ndjson(*objs):
    return "\n".join(json.dumps(o) for o in objs) + "\n"


@respx.mock
async def test_ollama_load_and_stream():
    respx.get("http://ollama:11434/api/tags").mock(return_value=httpx.Response(200, json={"models": [{"name": "llama3:latest"}]}))
    respx.post("http://ollama:11434/api/generate").mock(
        return_value=httpx.Response(
            200,
            text=_ndjson(
                {"response": "Hel", "done": False},
                {"response": "lo", "done": False},
                {"response": "", "done": True, "prompt_eval_count": 4, "eval_count": 2},
            ),
        )
    )
    svc = OllamaService("llama3", host="http://ollama:11434")
    await svc.load()
    assert svc.actual_model == "llama3:latest"
    result = await svc.generate(GenerationRequest(prompt="hi"))
    assert result["text"] == "Hello"
    assert result["usage"]["prompt_tokens"] == 4 and result["usage"]["completion_tokens"] == 2
    await svc.close()


@respx.mock
async def test_ollama_chat_messages_use_chat_endpoint():
    route = respx.post("http://o:1/api/chat").mock(
        return_value=httpx.Response(200, text=_ndjson({"message": {"content": "ok"}, "done": True, "eval_count": 1}))
    )
    svc = OllamaService("m", host="http://o:1")
    result = await svc.generate(GenerationRequest(messages=[{"role": "user", "content": "hi"}]))
    assert result["text"] == "ok" and route.called
    assert json.loads(route.calls[0].request.content)["messages"][0]["content"] == "hi"


@respx.mock
async def test_ollama_missing_model_fails_load():
    respx.get("http://o:1/api/tags").mock(return_value=httpx.Response(200, json={"models": [{"name": "other"}]}))
    with pytest.raises(ServiceError, match="ollama pull"):
        await OllamaService("llama3", host="http://o:1").load()


@respx.mock
async def test_ollama_http_error_is_service_error():
    respx.post("http://o:1/api/generate").mock(return_value=httpx.Response(500, text="kaboom"))
    with pytest.raises(ServiceError, match="500"):
        await OllamaService("m", host="http://o:1").generate(GenerationRequest(prompt="x"))


async def test_echo_respects_max_tokens():
    result = await EchoService().generate(GenerationRequest(prompt="a b c d", max_new_tokens=2))
    assert result["text"] == "a b"


async def test_hf_remote_requires_token(settings_factory):
    svc = create_service("hf_remote", "x", settings=settings_factory(hf_token=None))
    with pytest.raises(ServiceError, match="HF_TOKEN"):
        await svc.load()


def test_unknown_backend():
    with pytest.raises(ServiceError):
        create_service("nope", "m")
