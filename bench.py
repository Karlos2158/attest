# -*- coding: utf-8 -*-
import json
import time
import urllib.request

d = json.load(open("data/questions.json", encoding="utf-8"))
q = [x for x in d["questions"] if x["id"] == "2.1"][0]
student = ("JTBD это когда покупатель нанимает товар чтобы решить свою задачу. "
           "Например украшение покупают чтобы выглядеть красиво на празднике или сделать подарок.")
sys_p = ("Ты — строгий, но доброжелательный тренер по продажам. Оцени устный ответ ученика по эталону. "
         "Верни ТОЛЬКО JSON: {\"score\":0-5,\"verdict\":\"кратко\",\"correct\":[\"что верно\"],"
         "\"missing\":[\"что упущено\"],\"errors\":[\"неточности\"],\"model_answer\":\"образец ответа 2-4 предложения\","
         "\"followup\":\"один уточняющий вопрос\"}")
user = f"ВОПРОС: {q['question']}\n\nЭТАЛОННЫЙ ОТВЕТ:\n{q['answer']}\n\nОТВЕТ УЧЕНИКА (расшифровка речи):\n{student}"

for model in ["qwen3:14b", "qwen3.8:27b"]:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": user}],
        "stream": False, "format": "json", "think": False,
        "options": {"temperature": 0.3, "num_predict": 700},
    }).encode()
    t = time.time()
    try:
        r = json.load(urllib.request.urlopen(urllib.request.Request(
            "http://192.168.1.199:11434/api/chat", data=body,
            headers={"Content-Type": "application/json"}), timeout=600))
        print(model, "latency", round(time.time() - t, 1), "s")
        print(r["message"]["content"][:1200])
    except Exception as e:
        print(model, "ERROR", e)
    print("-" * 60)
