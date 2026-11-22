# -*- coding: utf-8 -*-
"""Разбор Excel с вопросами к аттестации в data/questions.json"""
import json
import re
import sys
from pathlib import Path

import openpyxl

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    r"C:\Users\GHO\Desktop\Вопросы_к_Аттестации_Консультанта_по_продажам19.11.26.xlsx")
OUT = Path(__file__).parent / "data" / "questions.json"

wb = openpyxl.load_workbook(SRC, data_only=True)
ws = wb.worksheets[0]
rows = [[("" if c is None else str(c).strip()) for c in r]
        for r in ws.iter_rows(values_only=True)]

block_re = re.compile(r"^Блок\s+(\d+)\.?\s*(.*)$", re.I)
num_re = re.compile(r"^(\d+(?:\.\d+)*)\.?$")

items = []
block = 0
block_title = ""
cur = None

for a, b in rows:
    m = block_re.match(a)
    if m:
        block = int(m.group(1))
        block_title = m.group(2).strip()
        cur = None
        continue
    m = num_re.match(a)
    if m and b:
        # новый вопрос: номер в колонке A, текст в B
        cur = {
            "id": m.group(1),
            "block": block,
            "blockTitle": block_title,
            "question": b,
            "answerParts": [],
        }
        items.append(cur)
        continue
    if cur is not None and b and not a:
        cur["answerParts"].append(b)

# Вопросы без ответа в конце файла — это экзаменационный список.
detailed = [it for it in items if it["answerParts"]]
summary = [it for it in items if not it["answerParts"]]

for it in detailed:
    it["answer"] = "\n".join(it.pop("answerParts")).strip()

# Сопоставляем экзаменационные вопросы с подробными по похожести текста
def norm(s: str) -> str:
    s = s.lower().replace("ё", "е")
    return re.sub(r"[^a-zа-я0-9 ]+", " ", s)


def tokens(s: str):
    return set(w for w in norm(s).split() if len(w) > 2)


exam = []
for it in summary:
    t = tokens(it["question"])
    best, best_score = None, 0.0
    for d in detailed:
        dt = tokens(d["question"])
        if not dt or not t:
            continue
        score = len(t & dt) / len(t | dt)
        if score > best_score:
            best, best_score = d, score
    exam.append({
        "id": it["id"],
        "question": it["question"],
        "sourceId": best["id"] if best and best_score > 0.35 else None,
        "match": round(best_score, 2),
    })

data = {
    "title": rows[0][0] if rows and rows[0] else "Вопросы к аттестации",
    "blocks": sorted({it["block"] for it in detailed}),
    "questions": detailed,
    "exam": exam,
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"Подробных вопросов с ответами: {len(detailed)}")
print(f"Экзаменационных вопросов: {len(exam)}")
print(f"Без надёжного соответствия: {sum(1 for e in exam if e['sourceId'] is None)}")
print(f"Записано: {OUT}")
