import java.util.ArrayList;
import java.util.List;

/**
 * Runs the Gradle wrapper on any OS, for git hooks: {@code java scripts/gradle.java <tasks>}.
 * Uses {@code sh ./gradlew} on Unix so a missing executable bit does not matter.
 */
class GradleLauncher {

    public static void main(String[] args) throws Exception {
        boolean windows = System.getProperty("os.name").toLowerCase().startsWith("windows");
        List<String> command =
                new ArrayList<>(windows ? List.of("cmd", "/c", "gradlew.bat") : List.of("sh", "./gradlew"));
        command.addAll(List.of(args));
        Process process = new ProcessBuilder(command).inheritIO().start();
        System.exit(process.waitFor());
    }
}
