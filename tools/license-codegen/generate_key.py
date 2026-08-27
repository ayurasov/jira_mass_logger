"""
Генерация пары ключей Ed25519 для офлайн-лицензирования JiraTime.

Запускается ОДИН РАЗ при первой настройке. Приватный ключ (license_private.key)
должен храниться только у владельца продукта, никогда не попадает в репозиторий
приложения и не публикуется. Публичный ключ (base64, 32 байта) нужно вставить
в src-tauri/src/license.rs в константу LICENSE_PUBLIC_KEY_B64.

Использование:
    python generate_key.py
"""
import base64
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

def main():
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()

    priv_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )

    with open("license_private.key", "wb") as f:
        f.write(priv_bytes)

    pub_b64 = base64.b64encode(pub_bytes).decode()
    print("=" * 70)
    print("Приватный ключ сохранён в license_private.key")
    print("ХРАНИТЕ ЕГО В БЕЗОПАСНОМ МЕСТЕ. НИКОГДА НЕ КОММИТТТЕ В РЕПОЗИТОрИй.")
    print("=" * 70)
    print("Публичный ключ (вставить в src-tauri/src/license.rs):")
    print(f'const LICENSE_PUBLIC_KEY_B64: &str = "{pub_b64}";')

if __name__ == "__main__":
    main()
