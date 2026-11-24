/** Read a reply using a device-local voice. Returns undefined when none matches. */
export function readLocalReply(text: string, onDone?: () => void): SpeechSynthesisUtterance | undefined {
  if (typeof window === 'undefined' || !window.speechSynthesis) return undefined
  const speech = window.speechSynthesis
  const language = /[\u3040-\u30ff]/u.test(text) ? 'ja' : /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en'
  const voice = speech.getVoices().find((item) => item.localService && item.lang.toLowerCase().startsWith(language))
  const content = text.replace(/^`{3}[^\n]*[\s\S]*?^`{3}/gm, '').replace(/^#{1,6}\s/gm, '').trim()
  if (!voice || !content) return undefined
  const request = new SpeechSynthesisUtterance(content)
  request.voice = voice
  request.lang = voice.lang
  if (onDone) {
    request.onend = onDone
    request.onerror = onDone
  }
  try {
    speech.cancel()
    speech.speak(request)
    return request
  } catch {
    return undefined
  }
}
