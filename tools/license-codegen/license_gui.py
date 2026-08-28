"""
GUI-генератор оффлайн-лицензионных кодов JiraTime.

Десктопное приложение на Tkinter (входит в стандартную библиотеку
Python — никаких дополнительных зависимостей кроме `cryptography`).
Работает полностью оффлайн, приватный ключ никуда не отправляется.

Запуск (из исходников):
    pip install cryptography
    python license_gui.py

Сборка в один .exe для Windows (см. README.md в этой папке):
    pip install pyinstaller
    pyinstaller --onefile --noconsole --name JiraTimeKeygen license_gui.py

При первом запуске, если license_private.key не найден рядом со скриптом/exe,
приложение предложит сгенерировать новую пару ключей (аналог generate_key.py).
НИКОГДА не переносите/не публикуйте license_private.key — это единственный
секрет, позволяющий выпускать валидные коды.

История выданных кодов сохраняется в license_history.json рядом со скриптом/exe и
переживает перезагрузки приложения — её можно открыть в любой момент кнопкой
«История». Журнал не содержит ничего секретного (только готовые коды и комментарии),
но всё равно не коммитится (см. .gitignore).
"""
import json
import os
import sys
import tkinter as tk
from datetime import datetime
from tkinter import messagebox, scrolledtext, ttk

from license_core import PRESET_LABELS, generate_code_with_grant, label_for_days, load_private_key


def _app_dir() -> str:
    """Каталог, рядом с которым хранить ключ и историю.

    В собранном PyInstaller-ом .exe (--onefile) sys.executable указывает на
    сам приложенный файл, а не на временную распакованную директоорию,
    поэтому ключ и история корректно сохраняются рядом с exe между запусками.
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


KEY_PATH = os.path.join(_app_dir(), "license_private.key")
HISTORY_PATH = os.path.join(_app_dir(), "license_history.json")


def _load_history() -> list[dict]:
    if not os.path.exists(HISTORY_PATH):
        return []
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001 — битый/повреждённый файл не должен ломать запуск
        return []


def _save_history(history: list[dict]) -> None:
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


class LicenseGeneratorApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("JiraTime — Генератор лицензионных кодов")
        self.geometry("600x560")
        self.minsize(560, 480)
        self.private_key = None
        self.history: list[dict] = _load_history()

        self._build_ui()
        self._load_or_prompt_key()

    # ------------------------------------------------------------------
    def _build_ui(self):
        pad = {"padx": 12, "pady": 8}

        header = ttk.Label(
            self, text="Генератор оффлайн-лицензионных кодов",
            font=("Segoe UI", 13, "bold"),
        )
        header.pack(anchor="w", **pad)

        self.key_status = ttk.Label(self, text="Ключ: не загружен", foreground="#a12c7b")
        self.key_status.pack(anchor="w", padx=12)

        # Комментарий/кому выдаётся код — применяется к любому способу генерации ниже.
        comment_frame = ttk.LabelFrame(self, text="Кому / для чего код (необязательно)")
        comment_frame.pack(fill="x", **pad)
        self.comment_var = tk.StringVar()
        ttk.Entry(comment_frame, textvariable=self.comment_var).pack(fill="x", padx=8, pady=8)

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

        btn_row = ttk.Frame(self)
        btn_row.pack(fill="x", **pad)
        ttk.Button(btn_row, text="Скопировать код повторно", command=self._copy_last).pack(side="left")
        ttk.Button(btn_row, text="История выданных кодов…", command=self._open_history_window).pack(side="left", padx=8)

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
                "license_private.key не найден рядом со скриптом/exe.\n\n"
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
        try:
            code, grant_id = generate_code_with_grant(self.private_key, days)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Ошибка генерации", f"Не удалось сгенерировать код: {e}")
            return
        label = label_for_days(days)
        comment = self.comment_var.get().strip()

        entry = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "days": days,
            "label": label,
            "code": code,
            "grant_id": grant_id,
            "comment": comment,
        }
        self.history.append(entry)
        try:
            _save_history(self.history)
        except Exception as e:  # noqa: BLE001
            messagebox.showwarning("История не сохранена", f"Код сгенерирован, но запись в историю не удалась: {e}")

        header_line = f"{label}" + (f" — {comment}" if comment else "")
        display = f"{header_line}\n{code}\n"

        self.result_text.configure(state="normal")
        self.result_text.insert("1.0", display + ("-" * 50) + "\n")
        self.result_text.configure(state="disabled")

        self.clipboard_clear()
        self.clipboard_append(code)

    def _copy_last(self):
        if not self.history:
            messagebox.showinfo("Нет кодов", "Сначала сгенерируйте код.")
            return
        self.clipboard_clear()
        self.clipboard_append(self.history[-1]["code"])
        messagebox.showinfo("Скопировано", "Последний сгенерированный код скопирован в буфер обмена.")

    # ------------------------------------------------------------------
    def _open_history_window(self):
        win = tk.Toplevel(self)
        win.title("История выданных кодов")
        win.geometry("760x420")

        columns = ("timestamp", "label", "comment", "code")
        tree = ttk.Treeview(win, columns=columns, show="headings")
        tree.heading("timestamp", text="Дата/время")
        tree.heading("label", text="Срок")
        tree.heading("comment", text="Кому / комментарий")
        tree.heading("code", text="Код")
        tree.column("timestamp", width=140, anchor="w")
        tree.column("label", width=160, anchor="w")
        tree.column("comment", width=180, anchor="w")
        tree.column("code", width=260, anchor="w")

        vsb = ttk.Scrollbar(win, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=vsb.set)
        tree.pack(side="left", fill="both", expand=True, padx=(10, 0), pady=10)
        vsb.pack(side="left", fill="y", pady=10)

        for entry in reversed(self.history):
            tree.insert(
                "", "end",
                values=(
                    entry.get("timestamp", ""),
                    entry.get("label", ""),
                    entry.get("comment", ""),
                    entry.get("code", ""),
                ),
            )

        def _copy_selected():
            sel = tree.selection()
            if not sel:
                return
            code = tree.item(sel[0], "values")[3]
            win.clipboard_clear()
            win.clipboard_append(code)

        btn_frame = ttk.Frame(win)
        btn_frame.pack(side="right", fill="y", padx=10, pady=10)
        ttk.Button(btn_frame, text="Скопировать код", command=_copy_selected).pack(fill="x")
        ttk.Label(
            btn_frame, text=f"Всего кодов: {len(self.history)}\n\nФайл:\n{HISTORY_PATH}",
            wraplength=140, justify="left",
        ).pack(fill="x", pady=12)


if __name__ == "__main__":
    app = LicenseGeneratorApp()
    app.mainloop()
