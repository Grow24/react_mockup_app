let context: AudioContext | null = null

// Browsers only allow sound after a tap, so the first call should come from a button press.
export function unlockSound() {
  if (typeof AudioContext === 'undefined') return
  context ??= new AudioContext()
  if (context.state === 'suspended') void context.resume()
}

export function beep(frequency = 880, milliseconds = 160, vibrate = false) {
  if (vibrate && typeof navigator.vibrate === 'function') navigator.vibrate(milliseconds)
  if (!context || context.state !== 'running') return
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0.0001, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.3, context.currentTime + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + milliseconds / 1000)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + milliseconds / 1000 + 0.02)
}
