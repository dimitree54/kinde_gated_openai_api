# Cloudflare Worker: Kinde + OpenAI Streaming Gateway

## Overview

This Cloudflare Worker acts as a secure gateway between your frontend application and the OpenAI API. It enables authorized users to stream responses from OpenAI's Chat Completions API without ever exposing your OpenAI API key to the client.

**Core Features:**

1.  **Authorization with Kinde:** It intercepts requests and validates a Kinde access token sent from the client.
2.  **Entitlement Gating:** It checks if the authenticated user has a specific entitlement (e.g., a "pro" feature flag) via the Kinde Account API.
3.  **Secure OpenAI Proxy:** If authorized, it forwards the client's request payload to the OpenAI API, injecting your secret OpenAI key on the server side.
4.  **Streaming Support:** It streams the Server-Sent Events (SSE) response from OpenAI directly back to the client, enabling real-time UI updates.

---

## Setup and Deployment

### Prerequisites

-   A Cloudflare account.
-   [Node.js](https://nodejs.org/en/) installed.
-   The Cloudflare Wrangler CLI installed globally:
    ```sh
    npm install -g wrangler
    ```

### Step 1: Configuration

This worker is configured using the `worker-openai/wrangler.toml` file. It's already set up with a name and entry point.

```toml
name = "kinde-openai-stream-gateway"
main = "index.ts"
compatibility_date = "2023-10-30"
```

### Step 2: Configure Secrets

This worker requires secrets to function securely. These are environment variables that are encrypted and stored in Cloudflare, never in your code.

You **must** use the `-c worker-openai/wrangler.toml` flag to ensure these secrets are applied to the correct worker.

1.  **`KINDE_DOMAIN`**: Your Kinde application domain.
    ```sh
    wrangler secret put KINDE_DOMAIN -c worker-openai/wrangler.toml
    ```
    (You will be prompted to enter the value, e.g., `your-org.kinde.com`)

2.  **`OPENAI_API_KEY`**: Your secret key from OpenAI.
    ```sh
    wrangler secret put OPENAI_API_KEY -c worker-openai/wrangler.toml
    ```

3.  **`ALLOWED_ORIGIN`** (Optional, but Recommended): For security, you should restrict which domains can call this worker. For local development, this would be `http://localhost:3000`. For production, it would be your app's domain (e.g., `https://myapp.com`).
    ```sh
    wrangler secret put ALLOWED_ORIGIN -c worker-openai/wrangler.toml
    ```

### Step 3: Deploy

Deploy the worker to your Cloudflare account.

```sh
wrangler deploy -c worker-openai/wrangler.toml
```

After a successful deployment, Wrangler will output the URL for your live worker (e.g., `https://kinde-openai-stream-gateway.your-subdomain.workers.dev`).

---

## API Usage

### Endpoint

-   **Method:** `POST`
-   **URL:** Your deployed worker URL.

### Authentication

The client must include a Kinde access token in the `Authorization` header.

-   **Header:** `Authorization: Bearer <your_kinde_access_token>`

### Request Body

The worker forwards the request body directly to the OpenAI Chat Completions API (`https://api.openai.com/v1/chat/completions`). You should send a JSON object matching the OpenAI API's requirements, ensuring `stream: true`.

**Example Request Body:**
```json
{
  "model": "gpt-3.5-turbo",
  "messages": [
    { "role": "user", "content": "Tell me a short story about a robot who dreams." }
  ],
  "stream": true
}
```

### Responses

-   **`200 OK`**: A successful response will stream `text/event-stream` data directly from OpenAI.
-   **`401 Unauthorized`**: The `Authorization` header is missing or the Kinde token is invalid.
-   **`403 Forbidden`**: The Kinde token is valid, but the user does not have the required feature entitlement (`ai_preprocessing`).
-   **`405 Method Not Allowed`**: The request method was not `POST`.
-   **`5xx` Errors**: An error occurred either within the Kinde API check or when calling the OpenAI API.

---

## Client-Side Example

Here is a JavaScript example showing how to call the worker and process the streaming response from your frontend application.

```javascript
async function callOpenAIStream() {
    const streamResultElement = document.getElementById("stream-result");
    if (!streamResultElement) return;

    // Replace with your deployed worker URL
    const workerUrl = 'https://kinde-openai-stream-gateway.your-subdomain.workers.dev';

    try {
        // Assume 'kinde' is your initialized Kinde client instance
        const accessToken = await kinde.getToken();
        if (!accessToken) {
            streamResultElement.textContent = "Error: Not authenticated.";
            return;
        }

        const openAIRequestPayload = {
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: "Tell me a short story about a robot who dreams of being a chef." }],
            stream: true,
        };

        const response = await fetch(workerUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(openAIRequestPayload),
        });

        if (!response.ok || !response.body) {
            const errorText = await response.text();
            streamResultElement.textContent = `Error: ${response.status} ${response.statusText}\n${errorText}`;
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        streamResultElement.textContent = ""; // Clear previous results

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.substring(6);
                    if (dataStr.trim() === '[DONE]') {
                        return; // Stream finished
                    }
                    try {
                        const data = JSON.parse(dataStr);
                        const content = data.choices[0]?.delta?.content;
                        if (content) {
                            streamResultElement.textContent += content;
                        }
                    } catch (e) {
                        // Ignore parsing errors for incomplete JSON chunks
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error calling OpenAI stream worker:", error);
        streamResultElement.textContent = "An unexpected error occurred.";
    }
}
