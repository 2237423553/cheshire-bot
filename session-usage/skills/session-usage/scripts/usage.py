#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ZCode 会话用量统计。

读取 ~/.zcode/cli/rollout/model-io-<会话ID>.jsonl（每行一次模型调用），
汇总输入/输出 Token、缓存命中、模型生成 TPS、会话跨度与本地费用估算。
仅用标准库；建议以 `python -I` 运行。
"""
import argparse
import json
import os
import re
import sys
import time
import tempfile
from datetime import datetime

ROLLOUT_DIR = os.environ.get("ZCODE_ROLLOUT_DIR") or os.path.join(
    os.path.expanduser("~"), ".zcode", "cli", "rollout"
)
SESSION_RE = re.compile(r"^model-io-(sess_|session_)(.+)\.jsonl$")
STALE_WARN_SECONDS = 15 * 60
CACHE_DIR = os.path.join(tempfile.gettempdir(), "zcode-session-usage")

BLANK_BUCKET = {"count": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                "durationMs": 0, "reasoningChars": 0, "reasoningCJK": 0}


def list_sessions():
    if not os.path.isdir(ROLLOUT_DIR):
        return []
    out = []
    for name in os.listdir(ROLLOUT_DIR):
        m = SESSION_RE.match(name)
        if not m:
            continue
        path = os.path.join(ROLLOUT_DIR, name)
        try:
            out.append({
                "id": m.group(1) + m.group(2),
                "path": path,
                "mtime": os.path.getmtime(path),
                "size": os.path.getsize(path),
            })
        except OSError:
            continue
    out.sort(key=lambda x: -x["mtime"])
    return out


def pick_session(user_arg):
    sessions = list_sessions()
    if user_arg:
        # 只按会话 ID 匹配（ID 来自文件名的正则捕获组）
        for s in sessions:
            if user_arg in s["id"]:
                return s
        sys.exit("错误：找不到该会话，可用 --list 查看会话列表")
    if not sessions:
        return None
    # 钩子环境注入会话 ID 时优先对号入座
    sid = os.environ.get("ZCODE_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID")
    if sid:
        for s in sessions:
            if sid in s["id"]:
                return s
        # 钩子给了 ID 但日志还没建立（新会话首条消息）→ 宁可不显示，也不用旧会话数据
        return None
    return sessions[0]


def parse_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def count_cjk(text):
    n = 0
    for ch in text:
        o = ord(ch)
        if (0x3400 <= o <= 0x9FFF or 0x3000 <= o <= 0x303F
                or 0xFF00 <= o <= 0xFFEF or 0xF900 <= o <= 0xFAFF):
            n += 1
    return n


def load_entries(path):
    # 收容校验：只读 rollout 目录内的会话日志
    real = os.path.realpath(path)
    roll = os.path.realpath(ROLLOUT_DIR)
    if not real.startswith(roll + os.sep):
        sys.exit("错误：会话文件必须位于 %s 内" % ROLLOUT_DIR)
    path = real
    entries, broken = [], 0
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError as e:
        sys.exit("错误：无法读取 %s：%s" % (path, e))
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                broken += 1
                continue
            resp = d.get("response") or {}
            usage = resp.get("usage")
            if not isinstance(usage, dict) or "inputTokens" not in usage:
                broken += 1
                continue
            model = d.get("model") or {}
            reasoning = resp.get("reasoningText") or ""
            entries.append({
                "model": model.get("modelId") or "?",
                "provider": model.get("providerId") or "?",
                "querySource": d.get("querySource") or "?",
                "attempt": d.get("attempt") or 1,
                "durationMs": d.get("durationMs") or 0,
                "startedAt": parse_ts(d.get("startedAt")),
                "completedAt": parse_ts(d.get("completedAt")),
                "input": int(usage.get("inputTokens") or 0),
                "output": int(usage.get("outputTokens") or 0),
                "cacheRead": int(usage.get("cacheReadTokens") or 0),
                "cacheWrite": int(usage.get("cacheWriteTokens") or 0),
                "reasoningChars": len(reasoning),
                "reasoningCJK": count_cjk(reasoning),
            })
    return entries, broken


def blank_bucket():
    return {"count": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
            "durationMs": 0, "reasoningChars": 0, "reasoningCJK": 0}


def aggregate(entries):
    totals, per_model, per_source = blank_bucket(), {}, {}
    for e in entries:
        for bucket in (totals, per_model.setdefault(e["model"], blank_bucket())):
            bucket["count"] += 1
            bucket["input"] += e["input"]
            bucket["output"] += e["output"]
            bucket["cacheRead"] += e["cacheRead"]
            bucket["cacheWrite"] += e["cacheWrite"]
            bucket["durationMs"] += e["durationMs"]
            bucket["reasoningChars"] += e["reasoningChars"]
            bucket["reasoningCJK"] += e["reasoningCJK"]
        per_source[e["querySource"]] = per_source.get(e["querySource"], 0) + 1
    totals["uncached"] = max(0, totals["input"] - totals["cacheRead"] - totals["cacheWrite"])
    return totals, per_model, per_source


def est_reasoning_tokens(bucket):
    """按字符构成估算：CJK 字符 ×1 token，其余 ×0.25 token。"""
    cjk = bucket["reasoningCJK"]
    other = bucket["reasoningChars"] - cjk
    return int(round(cjk * 1.0 + other * 0.25))


# ---------------------------------------------------------------- 页脚（钩子模式）

def compact_zh(n):
    """对齐 Cherry Studio：Intl.NumberFormat(locale,{notation:'compact',maximumFractionDigits:1}) 的中文效果。"""
    n = int(n)
    if n < 10000:
        return str(n)
    for unit, base in (("亿", 100000000), ("万", 10000)):
        if n >= base:
            s = ("%.1f" % (n / base)).rstrip("0").rstrip(".")
            return s + unit
    return str(n)


def _validated_path(session):
    """收容校验：会话文件必须是 rollout 目录内的真实路径。"""
    real = os.path.realpath(session["path"])
    roll = os.path.realpath(ROLLOUT_DIR)
    if not real.startswith(roll + os.sep):
        sys.exit("错误：会话文件必须位于 %s 内" % ROLLOUT_DIR)
    return real


def fresh_state():
    return {
        "size": 0,
        "broken": 0,
        "firstStarted": None,
        "lastCompleted": None,
        "totals": dict(BLANK_BUCKET),
        "perModel": {},
        "perSource": {},
        "lastCall": None,
    }


def _add(bucket, e):
    bucket["count"] += 1
    bucket["input"] += e["input"]
    bucket["output"] += e["output"]
    bucket["cacheRead"] += e["cacheRead"]
    bucket["cacheWrite"] += e["cacheWrite"]
    bucket["durationMs"] += e["durationMs"]
    bucket["reasoningChars"] += e["reasoningChars"]
    bucket["reasoningCJK"] += e["reasoningCJK"]


def _state_entry(d):
    resp = d.get("response") or {}
    usage = resp.get("usage")
    if not (isinstance(usage, dict) and "inputTokens" in usage):
        return None
    model = d.get("model") or {}
    reasoning = resp.get("reasoningText") or ""
    return {
        "model": model.get("modelId") or "?",
        "querySource": d.get("querySource") or "?",
        "attempt": d.get("attempt") or 1,
        "startedAt": d.get("startedAt"),
        "completedAt": d.get("completedAt"),
        "durationMs": d.get("durationMs") or 0,
        "input": int(usage.get("inputTokens") or 0),
        "output": int(usage.get("outputTokens") or 0),
        "cacheRead": int(usage.get("cacheReadTokens") or 0),
        "cacheWrite": int(usage.get("cacheWriteTokens") or 0),
        "reasoningChars": len(reasoning),
        "reasoningCJK": count_cjk(reasoning),
    }


def _merge(st, e):
    _add(st["totals"], e)
    _add(st["perModel"].setdefault(e["model"], dict(BLANK_BUCKET)), e)
    st["perSource"][e["querySource"]] = st["perSource"].get(e["querySource"], 0) + 1
    if e["startedAt"] and (st["firstStarted"] is None or e["startedAt"] < st["firstStarted"]):
        st["firstStarted"] = e["startedAt"]
    if e["completedAt"] and (st["lastCompleted"] is None or e["completedAt"] > st["lastCompleted"]):
        st["lastCompleted"] = e["completedAt"]
    st["lastCall"] = {"input": e["input"], "output": e["output"], "durationMs": e["durationMs"]}


def load_state(session):
    """解析会话日志构建累计状态（页脚模式，无缓存全量解析）。"""
    st = fresh_state()
    real = _validated_path(session)
    with open(real, "rb") as fh:
        data = fh.read()
    if not data.endswith(b"\n"):
        nl = data.rfind(b"\n")
        data = data[:nl + 1] if nl != -1 else b""
    for raw in data.split(b"\n"):
        raw = raw.strip()
        if not raw:
            continue
        try:
            d = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            st["broken"] += 1
            continue
        e = _state_entry(d)
        if e is None:
            st["broken"] += 1
            continue
        _merge(st, e)
    return st


def cmd_footer(session, st):
    """UserPromptSubmit 钩子模式：输出严格 JSON；无记录时输出空。"""
    t = st["totals"]
    if not t["count"]:
        return
    gen_tps = t["output"] / (t["durationMs"] / 1000.0) if t["durationMs"] else 0.0
    total = t["input"] + t["output"]
    footer = "— %s Tokens · %.1f Token/秒" % (compact_zh(total), gen_tps)
    ctx = (
        "[会话用量-自动注入] 截至本条消息发送前，本会话累计 %s Tokens（输入 %s · 输出 %s）"
        "· 模型生成 %.1f Token/秒 · %d 次调用。\n"
        "【必须执行】在本次回复正文的最末尾另起一行，一字不差地附上：\n%s\n"
        "不要修改、翻译或重新计算这些数字，不要附加其他说明；每次面向用户的回复都要带此页脚。"
        % (compact_zh(total), compact_zh(t["input"]), compact_zh(t["output"]), gen_tps, t["count"], footer)
    )
    print(json.dumps({"hookEventName": "UserPromptSubmit", "additionalContext": ctx},
                     ensure_ascii=False))


def human_num(n):
    return "{:,}".format(int(n))


def human_dur(ms):
    s = ms / 1000.0
    if s < 60:
        return "%.1f秒" % s
    m = int(s // 60)
    return "%d分%.1f秒" % (m, s - m * 60)


def human_size(n):
    if n >= 1024 * 1024:
        return "%.1f MB" % (n / 1024 / 1024)
    return "%.0f KB" % (n / 1024)


def local_dt(dt):
    if dt is None:
        return "?"
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")


def ts_to_dt(ts):
    return datetime.fromtimestamp(ts).astimezone()


def load_prices(script_dir):
    try:
        with open(os.path.join(script_dir, "prices.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def model_cost(prices, model, uncached, cache_read, cache_write, output):
    """返回该模型本次用量的美元成本；未配置单价时返回 None。

    prices.json 单价单位：US$/1M tokens。缓存读/写默认按输入单价计。
    """
    pr = prices.get(model)
    if not isinstance(pr, dict):
        return None
    pin, pout = pr.get("input"), pr.get("output")
    if not (isinstance(pin, (int, float)) and isinstance(pout, (int, float))):
        return None
    pcr = pr.get("cache_read", pin)
    pcw = pr.get("cache_write", pin)
    usd = uncached * pin / 1e6 + output * pout / 1e6
    if isinstance(pcr, (int, float)):
        usd += cache_read * pcr / 1e6
    if isinstance(pcw, (int, float)):
        usd += cache_write * pcw / 1e6
    return usd


def render_markdown(session, entries, totals, per_model, per_source, broken, usd):
    first = min((e["startedAt"] for e in entries if e["startedAt"]), default=None)
    last = max((e["completedAt"] for e in entries if e["completedAt"]), default=None)
    span_ms = int((last - first).total_seconds() * 1000) if first and last else 0
    gen_tps = totals["output"] / (totals["durationMs"] / 1000.0) if totals["durationMs"] else 0.0
    e2e_tps = totals["output"] / (span_ms / 1000.0) if span_ms else 0.0
    reasoning_est = est_reasoning_tokens(totals)
    main_model = max(per_model.items(), key=lambda kv: kv[1]["count"])[0] if per_model else "?"
    providers = sorted({e["provider"] for e in entries})
    retries = sum(1 for e in entries if e["attempt"] and e["attempt"] > 1)

    lines = ["## 📊 Token 使用 · %s" % session["id"], ""]
    lines.append("**%s** · %s" % (main_model, " · ".join(providers)))
    lines.append("")
    lines.append("%s → %s（本地时间，端到端耗时 %s）" % (
        local_dt(first), local_dt(last), human_dur(span_ms) if span_ms else "?"))
    lines.append("")
    lines.append("| 输入 | 输出 | 模型生成 TPS |")
    lines.append("|---|---|---|")
    lines.append("| %s Tokens | %s Tokens | %.1f Token/秒 |" % (
        human_num(totals["input"]), human_num(totals["output"]), gen_tps))
    lines.append("")
    cost_line = ("US$%.4f" % usd) if usd is not None else "—（未在 prices.json 配置该模型单价）"
    lines.append("**费用（本地估算）**：%s" % cost_line)
    lines.append("")
    lines.append("| 明细 | 数值 |")
    lines.append("|---|---|")
    src_desc = " · ".join("%s %d 次" % (k, v) for k, v in sorted(per_source.items(), key=lambda kv: -kv[1]))
    lines.append("| 模型调用 | %d 次（%s；重试 %d 次；未解析行 %d） |" % (
        totals["count"], src_desc, retries, broken))
    lines.append("| 输入合计 | %s Tokens |" % human_num(totals["input"]))
    lines.append("| ├ 未缓存 | %s Tokens |" % human_num(totals["uncached"]))
    lines.append("| ├ 缓存读取 | %s Tokens |" % human_num(totals["cacheRead"]))
    lines.append("| └ 缓存写入 | %s Tokens |" % human_num(totals["cacheWrite"]))
    lines.append("| 输出合计 | %s Tokens |" % human_num(totals["output"]))
    lines.append("| 推理 | ≈%s Tokens（按字符估算，非 API 精确值） |" % human_num(reasoning_est))
    lines.append("| 请求耗时合计 | %s |" % human_dur(totals["durationMs"]))
    lines.append("| 模型生成 TPS | %.1f Token/秒（输出 ÷ 请求耗时合计） |" % gen_tps)
    lines.append("| 首 Token 耗时 | —（日志未记录流式时间） |")
    lines.append("| 端到端耗时 | %s |" % (human_dur(span_ms) if span_ms else "?"))
    lines.append("| 端到端吞吐 | %.1f Token/秒 |" % e2e_tps)
    if len(per_model) > 1:
        lines.append("")
        lines.append("| 模型 | 调用 | 输入 | 输出 | 缓存读取 |")
        lines.append("|---|---|---|---|---|")
        for name, b in sorted(per_model.items(), key=lambda kv: -kv[1]["count"]):
            lines.append("| %s | %d | %s | %s | %s |" % (
                name, b["count"], human_num(b["input"]), human_num(b["output"]), human_num(b["cacheRead"])))
    if entries:
        e = entries[-1]
        tps = e["output"] / (e["durationMs"] / 1000.0) if e["durationMs"] else 0.0
        lines.append("")
        lines.append("最近一次调用：输入 %s · 输出 %s · 耗时 %s · %.1f Token/秒" % (
            human_num(e["input"]), human_num(e["output"]), human_dur(e["durationMs"]), tps))
    if time.time() - session["mtime"] > STALE_WARN_SECONDS:
        lines.append("")
        lines.append("> ⚠️ 该会话文件最后更新于 %s，可能不是当前会话（可用 `--list` 查看）。"
                     % local_dt(ts_to_dt(session["mtime"])))
    return "\n".join(lines)


def to_json(session, entries, totals, per_model, per_source, broken, usd):
    first = min((e["startedAt"] for e in entries if e["startedAt"]), default=None)
    last = max((e["completedAt"] for e in entries if e["completedAt"]), default=None)
    totals_json = dict(totals)
    totals_json["reasoningTokensEstimated"] = est_reasoning_tokens(totals)
    return {
        "session": {"id": session["id"], "path": session["path"], "mtime": session["mtime"]},
        "requests": totals["count"],
        "perSource": per_source,
        "retries": sum(1 for e in entries if e["attempt"] and e["attempt"] > 1),
        "unparsedLines": broken,
        "totals": totals_json,
        "perModel": per_model,
        "spanMs": int((last - first).total_seconds() * 1000) if first and last else 0,
        "firstAt": first.isoformat() if first else None,
        "lastAt": last.isoformat() if last else None,
        "costUsd": usd,
    }


def main():
    # Windows 控制台默认 GBK，强制 UTF-8 输出避免 emoji/中文报错
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass

    ap = argparse.ArgumentParser(description="ZCode 会话用量统计")
    ap.add_argument("--session", help="指定会话（ID 片段或 jsonl 文件路径），默认取最近修改的会话")
    ap.add_argument("--list", action="store_true", help="列出可用的会话文件")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON 而非 Markdown 面板")
    ap.add_argument("--footer", action="store_true", help="钩子模式：输出 UserPromptSubmit 注入 JSON")
    args = ap.parse_args()

    if args.list:
        sessions = list_sessions()
        if not sessions:
            sys.exit("未找到会话文件：%s" % ROLLOUT_DIR)
        print("| 会话 ID | 最后修改 | 大小 |")
        print("|---|---|---|")
        for s in sessions:
            print("| %s | %s | %s |" % (s["id"], local_dt(ts_to_dt(s["mtime"])), human_size(s["size"])))
        return

    session = pick_session(args.session)
    if session is None:
        if args.footer:
            return  # 新会话还没有日志，安静跳过
        sys.exit("错误：未找到会话日志（ZCODE_ROLLOUT_DIR 或 ~/.zcode/cli/rollout）")

    if args.footer:
        cmd_footer(session, load_state(session))
        return

    entries, broken = load_entries(session["path"])
    if not entries:
        sys.exit("错误：会话 %s 中没有可统计的模型调用记录" % session["id"])

    script_dir = os.path.dirname(os.path.abspath(__file__))
    prices = load_prices(script_dir)

    totals, per_model, per_source = aggregate(entries)
    usd, cost_ok = 0.0, True
    for name, b in per_model.items():
        c = model_cost(prices, name, b["input"] - b["cacheRead"] - b["cacheWrite"],
                       b["cacheRead"], b["cacheWrite"], b["output"])
        if c is None:
            cost_ok = False
        else:
            usd += c
    usd = usd if cost_ok else None

    if args.json:
        print(json.dumps(to_json(session, entries, totals, per_model, per_source, broken, usd),
                         ensure_ascii=False, indent=2))
    else:
        print(render_markdown(session, entries, totals, per_model, per_source, broken, usd))


if __name__ == "__main__":
    main()
