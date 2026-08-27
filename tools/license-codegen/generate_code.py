"""
CLI-генератор офлайн-лицензионных кодов JiraTime.

Требует license_private.key (см. generate_key.py) в текущей директории
или указанный через --key.

Использование:
    python generate_code.py --preset trial_7
    python generate_code.py --days 45
    python generate_code.py --preset year_1 --key /path/license_private.key
"""
import argparse
import sys

from license_core import PRESETS, generate_code, label_for_days, load_private_key


def main():
    parser = argparse.ArgumentParser(description="Генератор офлайн-лицензионных кодов JiraTime")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preset", choices=sorted(PRESETS.keys()), help="Готовый пресет длительности")
    group.add_argument("--days", type=int, help="Произвольное число дней (0-65535)")
    parser.add_argument("--key", default="license_private.key", help="Путь к приватному ключу")
    args = parser.parse_args()

    days = PRESETS[args.preset] if args.preset else args.days

    try:
        private_key = load_private_key(args.key)
    except FileNotFoundError:
        print(f"Приватный ключ не найден: {args.key}. Сначала запустите generate_key.py", file=sys.stderr)
        sys.exit(1)

    code = generate_code(private_key, days)
    print(f"# {label_for_days(days)}")
    print(code)


if __name__ == "__main__":
    main()
