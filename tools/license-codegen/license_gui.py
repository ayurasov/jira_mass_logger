"""
GUI-генератор офлайн-лицензионных кодов JiraTime.

Простейшее настольное приложение на Tkinter (входит в стандартную библиотеку
Python — никаких дополнительных зависимостей кроме `cryptography`).
Работает полностью офлайн, приватный ключ никуда не отправляется.

Запуск:
    pip install cryptography
    python license_gui.py

При первом запуске, если license_private.key не найден рядом со скриптом,
приложение предложит сгенерировать новую пару ключей (аналог generate_key.py).
НИКОГДА не переносите/не публикуйте license_private.key — это единственный
секрет, позволяющий выпускать валидные коды.
"""
import os
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

from license_core import PRESET_LABELS, generate_code, label_for_days, load_private_key

KEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "license_private.key")


class LicenseGeneratorApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("JiraTime — Генератор лицензионных кодов")
        self.geometry("560x480")
        self.resizable(False, False)
        self.private_key = None
        self.history: list[str] = []

        self._build_ui()
        self._load_or_prompt_key()

    # ------------------------------------------------------------------
    def _build_ui(self):
        pad = {"padx": 12, "pady": 8}

        header = ttk.Label(
            self, text="Генератор офлайн-лицензионных кодов",
            font=("Segoe UI", 13, "bold"),
        )
        header.pack(anchor="w", **pad)

        self.key_status = ttk.Label(self, text="Ключ: не загружен", foreground="#a12c7b")
        self.key_status.pack(anchor="w", padx=12)

        preset_frame = ttk.LabelFrame(self, text="Пресеты длительности")
        preset_frame.pack(fill="x", **pad)

        for days, label in PRESET_LABELS.items():
            btn = ttk.Button(
                preset_frame, text=label,
                command=lambda d=days: self._on_generate(d),
            )
            btn.pack(fill="x", padx=8, pady=4)

        custom_frame = ttk.LabelFrame(self, text="Произвольное число дней")
        custom_frame.pack(fill="x", **pad)

        inner = ttk.Frame(custom_frame)
        inner.pack(fill="x", padx=8, pady=8)
        self.custom_days_var = tk.StringVar()
        ttk.Entry(inner, textvariable=self.custom_days_var, width=10).pack(side="left")
        ttk.Button(inner, text="Сгенерировать", command=self._on_generate_custom).pack(side="left", padx=8)

        result_frame = ttk.LabelFrame(self, text="Последний код (уже скопирован в буфер обмена)")
        result_frame.pack(fill="both", expand=True, **pad)

        self.result_text = scrolledtext.ScrolledText(result_frame, height=6, wrap="word", font=("Consolas", 11))
        self.result_text.pack(fill="both", expand=True, padx=8, pady=8)
        self.result_text.configure(state="disabled")

        copy_btn = ttk.Button(self, text="Скопировать код повторно", command=self._copy_last)
        copy_btn.pack(**pad)

    # ------------------------------------------------------------------
    def _load_or_prompt_key(self):
        if os.path.exists(KEY_PATH):
            try:
                self.private_key = load_private_key(KEY_PATH)
                self.key_status.configure(
                    text=f"Ключ: загружен из {KEY_PATH}", foreground="#437a22"
                )
            except Exception as e:  # noqa: BLE001
                messagebox.showerror("Ошибка ключа", f"Не удалось загрузить ключ: {e}")
        else:
            if messagebox.askyesno(
                "Ключ не найден",
                "license_private.key не найден рядом со скриптом.\n\n"
                "Сгенерировать новую пару ключей сейчас?\n"
                "(публичный ключ придётся вставить в license.rs основного приложения)",
            ):
                self._generate_new_key()
            else:
                self.key_status.configure(text="Ключ: не загружен — генерация недоступна", foreground="#a12c7b")

    def _generate_new_key(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization
        import base64

        priv = Ed25519PrivateKey.generate()
        pub = priv.public_key()
        priv_bytes = priv.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        pub_bytes = pub.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        with open(KEY_PATH, "wb") as f:
            f.write(priv_bytes)

        self.private_key = priv
        self.key_status.configure(text=f"Ключ: сгенерирован и сохранён в {KEY_PATH}", foreground="#437a22")

        pub_b64 = base64.b64encode(pub_bytes).decode()
        messagebox.showinfo(
            "Новый ключ создан",
            "Вставьте эту строку в src-tauri/src/license.rs (константа LICENSE_PUBLIC_KEY_B64) "
            "и пересоберите приложение:\n\n"
            f'const LICENSE_PUBLIC_KEY_B64: &str = "{pub_b64}";\n\n'
            "license_private.key НЕ публикуйте и не коммитьте в репозиторий приложения.",
        )

    # ------------------------------------------------------------------
    def _on_generate(self, days: int):
        self._generate_and_show(days)

    def _on_generate_custom(self):
        raw = self.custom_days_var.get().strip()
        if not raw.isdigit():
            messagebox.showwarning("Некорректное значение", "Введите целое число дней (0-65535).")
            return
        days = int(raw)
        if days > 65535:
            messagebox.showwarning("Слишком большое значение", "Максимум 65535 дней.")
            return
        self._generate_and_show(days)

    def _generate_and_show(self, days: int):
        if self.private_key is None:
            messagebox.showerror("Нет ключа", "Приватный ключ не загружен, генерация невозможна.")
            return
        code = generate_code(self.private_key, days)
        label = label_for_days(days)
        entry = f"{label}\n{code}\n"

        self.result_text.configure(state="normal")
        self.result_text.insert("1.0", entry + ("-" * 50) + "\n")
        self.result_text.configure(state="disabled")

        self.clipboard_clear()
        self.clipboard_append(code)
        self.history.append(code)

    def _copy_last(self):
        if not self.history:
            messagebox.showinfo("Нет кодов", "Сначала сгенерируйте код.")
            return
        self.clipboard_clear()
        self.clipboard_append(self.history[-1])
        messagebox.showinfo("Скопировано", "Последний код скопирован скопирован в буфер обена".rstrip()}"
            )


if __name__ == "__main__":
    app = LicenseGeneratorApp()
    app.mainloop()
