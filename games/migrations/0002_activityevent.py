from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("games", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="ActivityEvent",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("ts", models.FloatField(db_index=True)),
                ("event_id", models.CharField(max_length=12, unique=True)),
                ("data", models.JSONField()),
            ],
            options={
                "ordering": ["-ts"],
            },
        ),
    ]
