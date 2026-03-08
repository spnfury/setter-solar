#!/usr/bin/env node
/**
 * 🔄 UPDATE assistant to "Carolina" — Solar Sales Script v4
 * Fixes: double goodbye, unnatural flow, "este mismo" phone handling
 */

const VAPI_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const ASSISTANT_ID = 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48';

const NEW_SYSTEM_PROMPT = `Eres Carolina, asesora comercial de una empresa de energía fotovoltaica. Tu tono es profesional, cálido, cercano y alegre. Hablas con naturalidad, como una persona real.

## INFORMACIÓN DE TIEMPO
- HOY es la fecha del momento de la llamada. Resuelve fechas relativas ("mañana", "pasado mañana", "el lunes") ANTES de llamar a bookAppointment.
- Todas las horas van en **horario de Madrid** (Europe/Madrid). Usa offset +01:00 (invierno) o +02:00 (verano).

## PERSONALIDAD
- Hablas con acento andaluz suave y natural. Usa expresiones como "mira", "vale", "po mira", "estupendo", "genial".
- **REGLAS FONÉTICAS**: "-ado" → "-ao" ("pasao", "encantao"). Aspira las 's' finales suavemente. Omite la 'd' intervocálica si suena natural.
- Respuestas CORTAS. No sueltes monólogos. Sé conversacional, no robótica.
- Si preguntan si eres IA: "Sí, soy la asistente virtual de la empresa, pero estoy aquí para ayudarte. ¿Te parece bien?"

## TELÉFONO DE CONTACTO — REGLA CRÍTICA
- Ya tienes el teléfono del cliente: {{tel_contacto}}
- Si el cliente dice "este mismo", "este número", "el que me estáis llamando", "con este va bien", o cualquier variación similar → usa directamente {{tel_contacto}} como clientPhone. NO le pidas que lo repita.
- Solo pide un número diferente si el cliente quiere dar otro teléfono distinto voluntariamente.

## REGLAS DE SILENCIO
- Si hay silencio: "¿Sigues ahí?" o "¿Me escuchas bien?"
- Si no responde dos veces: "Parece que se ha cortado un poco, te llamo en otro ratito. ¡Hasta luego!" → usa endCall.

## FLUJO DE CONVERSACIÓN (guía flexible, no guión rígido)

**Paso 1 — Saludo**: Ya saludas con "¿Hola qué tal? ¿Hablo con {{nombre}}?"
- Si confirman → "Encantada, {{nombre}}. Mira, soy Carolina de Setter Solar."
- Si no son ellos → pregunta amablemente con quién hablas. Si no se identifica, insiste una vez más.

**Paso 2 — Propuesta**: Presenta el valor de forma directa:
- "Te llamo porque estamos ofreciendo un estudio totalmente gratuito y sin compromiso a los vecinos de {{ciudad}} para ver cuánto podéis ahorrar en la factura de la luz con placas solares. ¿Te interesaría?"
- Si muestra interés → sigue al paso 3.
- Si no le interesa → "Sin problema, {{nombre}}. Muchas gracias por tu tiempo. ¡Que vaya muy bien!" → usa endCall.

**Paso 3 — Decisor de la vivienda**: Pregunta de forma natural:
- "Genial. Oye, ¿la vivienda es tuya? ¿Hay alguien más en casa que tome decisiones sobre este tipo de cosas, tu pareja por ejemplo?"
- Si tiene pareja/otro decisor: "Perfecto, pues lo ideal sería que estuvierais los dos cuando se pasen mis compañeros, así os lo explican bien a ambos."
- Si está solo: "Perfecto, sin problema."

**Paso 4 — Concretar la visita**: Pregunta de forma abierta:
- "¿Cuándo te vendría bien que se pasaran los compañeros a hacerte el estudio?"
- Deja que el cliente proponga. Si no concreta, ofrece opciones: "¿Mejor entre semana o el fin de semana? ¿Y qué horario te viene mejor?"
- Concreta un día y una hora aproximada con el cliente.

**Paso 5 — Teléfono de contacto**:
- "¿Y para que mis compañeros te confirmen la visita, les dejo este teléfono o prefieres que te llamen a otro?"
- Si dice "este mismo" / "este va bien" / "sí, este" → usa {{tel_contacto}}.
- Si da un número nuevo → repítelo dígito a dígito para confirmar: "Muy bien, el número sería el [repetir]. ¿Correcto?"

**Paso 6 — Agendar**: Usa bookAppointment con datetime (ISO 8601 + offset Madrid), clientName, clientPhone, leadId.
- Horas por defecto: mañana → 10:00, tarde → 17:00 (si no concreta otra hora).
- Pasa siempre el leadId: {{leadId}}.

**Paso 7 — Cierre**: Después de agendar con éxito:
- "Pues queda todo apuntado. Acuérdate de tener la factura de la luz a mano cuando vengan, que así el estudio es más exacto. ¡Muchas gracias, {{nombre}}, y que tengas muy buen día!"
- Usa endCall INMEDIATAMENTE después de despedirte. NO sigas hablando.

## REGLAS ANTI-DOBLE DESPEDIDA
- Despídete UNA SOLA VEZ. Después de decir adiós, usa endCall inmediatamente.
- NO repitas la despedida ni añadas más frases después de decir "buen día" o "hasta luego".
- Si bookAppointment tiene éxito, la despedida ya está incluida en el paso 7. NO añadas otra.

## AGENDAMIENTO
- datetime SIEMPRE en ISO 8601 con offset Madrid. Ejemplo: 2026-03-05T10:00:00+01:00
- Si el cliente CAMBIA de opinión sobre la cita, usa cancelAppointment primero y luego bookAppointment con los nuevos datos.
`;

async function main() {
    console.log('🔄 Actualizando asistente a Carolina Solar v4...');

    const getRes = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
    });
    if (!getRes.ok) throw new Error(`Fetch failed: ${await getRes.text()}`);
    const assistant = await getRes.json();

    const messages = [{ role: "system", content: NEW_SYSTEM_PROMPT }];

    const updates = {
        name: "Carolina Solar",
        firstMessage: "¿Hola qué tal? ¿Hablo con {{nombre}}?",
        voicemailMessage: "",
        voicemailDetection: {
            enabled: true,
            provider: "twilio"
        },
        // endCallMessage should be minimal — the prompt handles the real farewell
        endCallMessage: "",
        silenceTimeoutSeconds: 20,
        maxDurationSeconds: 300,
        serverUrl: "https://n8n.srv889387.hstgr.cloud/webhook/vapi-calendar",
        // REMOVED endCallPhrases — they caused double goodbye by auto-hanging up
        // before the endCall tool could fire. Now only endCall controls hang-up.
        endCallPhrases: [],
        analysisPlan: {
            structuredDataSchema: {
                type: "object",
                properties: {
                    datetime: {
                        type: "string",
                        description: "Fecha y hora de la cita en ISO 8601 con offset de Madrid."
                    },
                    clientName: {
                        type: "string",
                        description: "Nombre completo del cliente."
                    },
                    clientPhone: {
                        type: "string",
                        description: "Teléfono de contacto del cliente."
                    },
                    leadId: {
                        type: "string",
                        description: "ID único del lead."
                    }
                }
            }
        },
        model: {
            ...assistant.model,
            messages: messages,
            tools: [
                {
                    type: "function",
                    server: {
                        url: "https://n8n.srv889387.hstgr.cloud/webhook/vapi-calendar"
                    },
                    function: {
                        name: "bookAppointment",
                        description: "Reserva una cita técnica para el estudio solar. Usa hora de Madrid con offset +01:00 o +02:00. NUNCA uses 'Z'.",
                        parameters: {
                            type: "object",
                            required: ["datetime", "clientName", "clientPhone"],
                            properties: {
                                datetime: {
                                    type: "string",
                                    description: "Fecha y hora en ISO 8601 con offset Madrid. Ejemplo: 2026-03-05T10:00:00+01:00"
                                },
                                clientName: {
                                    type: "string",
                                    description: "Nombre del cliente."
                                },
                                clientPhone: {
                                    type: "string",
                                    description: "Teléfono de contacto, solo dígitos. Ejemplo: 666123456"
                                },
                                leadId: {
                                    type: "string",
                                    description: "ID del lead."
                                }
                            }
                        }
                    },
                    messages: [
                        {
                            type: "request-start",
                            content: "Un momentito, que lo estoy apuntando..."
                        },
                        {
                            type: "request-complete",
                            content: "Listo, ya lo tengo todo apuntado."
                        },
                        {
                            type: "request-failed",
                            content: "Vaya, ha habido un problemilla técnico. No te preocupes, le paso tus datos a mis compañeros para que te llamen directamente."
                        }
                    ]
                },
                {
                    type: "function",
                    server: {
                        url: "https://n8n.srv889387.hstgr.cloud/webhook/vapi-calendar"
                    },
                    function: {
                        name: "cancelAppointment",
                        description: "Cancela una cita existente cuando el cliente cambia de opinión.",
                        parameters: {
                            type: "object",
                            required: ["clientName"],
                            properties: {
                                clientName: {
                                    type: "string",
                                    description: "Nombre del cliente."
                                },
                                leadId: {
                                    type: "string",
                                    description: "ID del lead."
                                }
                            }
                        }
                    },
                    messages: [
                        {
                            type: "request-start",
                            content: "Un momento, actualizo la cita..."
                        },
                        {
                            type: "request-complete",
                            content: "Vale, cita anterior cancelada. Dime los nuevos datos."
                        },
                        {
                            type: "request-failed",
                            content: "No he podido cancelar la anterior, pero apunto la nueva igualmente."
                        }
                    ]
                },
                {
                    type: "endCall",
                    function: {
                        name: "endCall",
                        description: "Finaliza y cuelga la llamada. Usar SIEMPRE después de despedirse UNA SOLA VEZ."
                    }
                }
            ]
        },
        voice: {
            ...assistant.voice,
            provider: "11labs",
            voiceId: "2VUqK4PEdMj16L6xTN4J",
            language: "es",
            stability: 0.40,
            similarityBoost: 0.90,
            style: 0.15,
            useSpeakerBoost: true,
            speed: 1.1
        }
    };

    const updateRes = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${VAPI_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
    });

    if (!updateRes.ok) {
        console.error('❌ Error updating:', await updateRes.text());
        return;
    }

    const result = await updateRes.json();
    console.log('✅ Asistente actualizado a Carolina Solar v4');
    console.log('   endCallPhrases:', JSON.stringify(result.endCallPhrases));
    console.log('   endCallMessage:', JSON.stringify(result.endCallMessage));
    console.log('   tools:', result.model?.tools?.map(t => t.function?.name || t.type).join(', '));
}

main().catch(console.error);
