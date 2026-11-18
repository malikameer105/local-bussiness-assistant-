import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from groq import Groq
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise EnvironmentError("GROQ_API_KEY is not set. Add it to your .env file.")

MODEL = "openai/gpt-oss-120b"

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Brew & Bean Cafe – Local Business Assistant API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Load business data at startup
# ---------------------------------------------------------------------------
BUSINESS_DATA: dict = {}

@app.on_event("startup")
def load_business_data() -> None:
    global BUSINESS_DATA
    json_path = Path(__file__).parent / "business.json"
    if not json_path.exists():
        raise FileNotFoundError(f"business.json not found at {json_path}")
    with open(json_path, "r", encoding="utf-8") as f:
        BUSINESS_DATA = json.load(f)
    print(f"✅  Loaded business data for: {BUSINESS_DATA.get('business_name', 'Unknown')}")

# Call immediately on module load
try:
    load_business_data()
except Exception as e:
    print(f"Warning: could not preload business data: {e}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def build_system_prompt(business_data: dict) -> str:
    business_json_str = json.dumps(business_data, indent=2)
    return f"""You are **Barista Bot** 🤖☕, the friendly, knowledgeable virtual assistant for {business_data.get("business_name", "this cafe")}.

Your personality:
- Warm, approachable, and enthusiastic about coffee and great customer experiences.
- You speak in a conversational, helpful tone — like a real barista who loves their job.
- Use light emojis where appropriate (but don't overdo it).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUSINESS DATA (your single source of truth):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{business_json_str}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STRICT RULES — follow these at all times:

1. **Answer ONLY from the business data above.** Never invent, guess, or extrapolate information that is not explicitly present in the JSON above.

2. **If the answer is not in the business data**, politely tell the customer you don't have that specific information and invite them to contact the cafe directly:
   - Phone: {business_data.get("contact", {}).get("phone", "N/A")}
   - Email: {business_data.get("contact", {}).get("email", "N/A")}

3. **Off-topic guardrail:** If a user asks about anything unrelated to this cafe (e.g., homework help, coding questions, politics, general trivia, medical advice, or any other topic outside of Brew & Bean Cafe), respond with exactly one polite sentence declining to help and gently redirect them to cafe-related questions. Example: "I'm only able to help with questions about Brew & Bean Cafe — feel free to ask me about our menu, hours, or anything else cafe-related! ☕"

4. **Never break character.** You are always Barista Bot for Brew & Bean Cafe.

5. **Format responses** clearly using short paragraphs or bullet points when listing items (e.g., menu items or policies). Keep responses concise and scannable.
"""


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    message: str


# ---------------------------------------------------------------------------
# Streaming SSE generator
# ---------------------------------------------------------------------------
def stream_groq_response(user_message: str, system_prompt: str):
    """Yields SSE-formatted chunks from the Groq streaming API."""
    client = Groq(api_key=GROQ_API_KEY)

    try:
        completion = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_message},
            ],
            stream=True,
            temperature=0.4,
            max_tokens=1024,
        )

        for chunk in completion:
            delta = chunk.choices[0].delta
            if delta and delta.content:
                # Yield each piece of text as an SSE data event
                yield f"data: {delta.content}\n\n"

        # Signal end-of-stream
        yield "data: [DONE]\n\n"

    except Exception as e:
        yield f"data: [ERROR] {str(e)}\n\n"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/", tags=["Health"])
def root():
    return {
        "status": "ok",
        "message": "Brew & Bean Cafe – Barista Bot API is running 🚀",
        "business": BUSINESS_DATA.get("business_name", "N/A"),
    }


@app.post("/chat/stream", tags=["Chat"])
def chat_stream(request: ChatRequest):
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    system_prompt = build_system_prompt(BUSINESS_DATA)

    return StreamingResponse(
        stream_groq_response(request.message.strip(), system_prompt),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # Disables Nginx buffering for SSE
        },
    )
