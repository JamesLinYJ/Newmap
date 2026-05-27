# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具 Provider 契约校验 CLI
#
#   文件:       validate_provider.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 提供 `python -m tool_registry.validate_provider module:object` 命令，
# 让仓库内工具模块在合并前先本地校验 manifest、工具定义、参数和安全声明。

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .providers import ToolProviderContractError, _load_provider_from_object_path, validate_provider


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a geo-agent-platform tool provider.")
    parser.add_argument("provider", help="Provider object path, for example my_tools.provider:provider")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON output.")
    args = parser.parse_args(argv)
    cwd = str(Path.cwd())
    if cwd not in sys.path:
        sys.path.insert(0, cwd)

    try:
        provider = _load_provider_from_object_path(args.provider)
        validate_provider(provider)
    except ToolProviderContractError as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"工具 Provider 校验失败：{exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": f"{exc.__class__.__name__}: {exc}"}, ensure_ascii=False))
        else:
            print(f"工具 Provider 加载失败：{exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 2

    manifest = provider.manifest
    definitions = provider.list_definitions()
    payload = {
        "ok": True,
        "providerId": manifest.provider_id,
        "name": manifest.name,
        "version": manifest.version,
        "toolCount": len(definitions),
        "tools": [definition.name for definition in definitions],
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(f"工具 Provider 校验通过：{manifest.provider_id} ({len(definitions)} tools)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
