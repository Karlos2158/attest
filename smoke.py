# -*- coding: utf-8 -*-
import json
import urllib.request

def post(path, obj):
    req = urllib.request.Request(
        "http://localhost:8765" + path,
        data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))

print("=== grade (эталон есть) ===")
print(json.dumps(post("/api/grade", {
    "questionId": "1.1",
    "studentAnswer": ("Консультант продаёт украшения из муранского стекла, консультирует покупателей, "
                      "соблюдает стандарты, применяет технологию продаж, ведёт отчётность и учится на тренингах."),
    "model": "qwen3:14b",
}), ensure_ascii=False, indent=1)[:1200])

print("=== grade (эталона нет) ===")
print(json.dumps(post("/api/grade", {
    "questionId": "",
    "question": "Каким должен быть внешний вид и эмоциональный настрой консультанта по продажам?",
    "reference": "",
    "studentAnswer": ("Опрятный, чистый, ухоженный вид, форма по стандарту, приветливая улыбка, "
                      "позитивный настрой, доброжелательность, уверенность."),
    "model": "qwen3:14b",
}), ensure_ascii=False, indent=1)[:1200])

print("=== ask ===")
print(json.dumps(post("/api/ask", {
    "question": "Что такое JTBD и зачем он нужен?",
    "model": "qwen3:14b",
}), ensure_ascii=False, indent=1)[:1200])
