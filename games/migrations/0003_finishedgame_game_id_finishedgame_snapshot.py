from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("games", "0002_activityevent"),
    ]

    operations = [
        migrations.AddField(
            model_name="finishedgame",
            name="game_id",
            field=models.CharField(blank=True, db_index=True, default="", max_length=64),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="finishedgame",
            name="snapshot",
            field=models.JSONField(blank=True, null=True),
        ),
    ]
