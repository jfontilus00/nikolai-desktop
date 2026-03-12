
export function attachVoiceHotkeys(loop: any) {
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      loop.handleBargeIn();
    }
  });
}
